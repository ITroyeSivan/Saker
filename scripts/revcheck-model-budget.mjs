import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const boundary=resolve(root,'../_ref/tmp'), directory=mkdtempSync(join(boundary,'model-budget-reverse-'));
const source=readFileSync(join(root,'plugins/dsh-redteam-results/lib/model-budget.js'),'utf8');
const suite=readFileSync(join(root,'scripts/test-model-budget.mjs'),'utf8');
const variants=[
  {id:'no-call-ceiling',from:'status.chargedCalls>=status.limits.modelCalls',to:'false',fail:'shared root admission'},
  {id:'unknown-is-zero',from:'unknownCalls||unresolvedCalls ? null : knownTokens',to:'knownTokens',fail:'shared root admission'},
  {id:'no-token-hold',from:'heldTokens+=row.reservedTokens ?? 0',to:'heldTokens+=0',fail:'strict token reservations'},
  {id:'trust-estimate',from:"['exact','upper-bound'].includes(counter.quality)",to:"['exact','upper-bound','estimate'].includes(counter.quality)",fail:'estimated, stale or incomplete'},
];
try{
  for(const variant of variants){
    assert.equal(source.split(variant.from).length-1,1,variant.id+': exact mutation anchor');
    const module=join(directory,variant.id+'.mjs');writeFileSync(module,source.replace(variant.from,variant.to));
    // Keep the actual production store and task policy; redirect only the tested
    // ledger module. Run the targeted sequential cases; race/restart coverage
    // uses the real suite separately, avoiding false reds from temp imports.
    const runner=join(directory,variant.id+'-test.mjs');
    const tests=suite.slice(0,suite.indexOf("await test('simultaneous SQLite"))+'\nprocess.exitCode=failures?1:0;\n';
    writeFileSync(runner,tests.replace(/'\.\.\/plugins\/dsh-redteam-results\/lib\/([^']+)'/g,(_all,name)=>JSON.stringify(pathToFileURL(name==='model-budget.js'?module:join(root,'plugins/dsh-redteam-results/lib',name)).href)));
    const result=spawnSync(process.execPath,['--import',pathToFileURL(join(root,'scripts/test-stub-register.mjs')).href,runner],{cwd:root,encoding:'utf8',env:{...process.env,TEMP:boundary,TMP:boundary,TMPDIR:boundary}});
    assert.notEqual(result.status,0,variant.id+': must fail');
    assert((result.stdout+result.stderr).includes('FAIL '+variant.fail),variant.id+': targeted behavior must fail\n'+result.stdout+result.stderr);
    console.log('ok reverse '+variant.id+': targeted assertion failed');
  }
}finally{
  const inside=relative(boundary,directory);assert(inside&&!inside.startsWith('..')&&!isAbsolute(inside));
  rmSync(directory,{recursive:true,force:true});
}
