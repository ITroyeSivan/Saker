// Use the official Desktop's compiler: the unit stub intentionally does not compile schemas.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { apply } from '../plugins/dsh-stage-gate/lib/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = process.env.DSH_DESKTOP_DIR || resolve(root, '../_ref/dsh-src-0.2.0-rc.2/desktop-runtime');
const executable = join(desktop, 'DeepSeek Harness.exe');
if (process.platform !== 'win32' || !existsSync(executable)) {
  console.log('skip official Windows Desktop unavailable; schema compilation was not tested');
  process.exit(0);
}
const tools = [];
apply({ tools: { register: tool => tools.push({ name: tool.name, parameters: tool.parameters, output: tool.output?.schema }) } });
const native = `
const {createRequire}=require('node:module');
const fs=require('node:fs');
const path=require('node:path');
const req=createRequire(path.join(process.argv[1],'resources/app.asar/dsh/package.json'));
const host=req('@deepseek-ai/dsh-tools');
const definitions=JSON.parse(fs.readFileSync(0,'utf8'));
for(const tool of definitions){host.parameterSchemaSpecToJsonSchema(tool.parameters);if(tool.output)host.valueSchemaSpecToJsonSchema(tool.output);}
const item=definitions.find(t=>t.name==='operation_intent');
const mutant=structuredClone(item.parameters);
delete mutant.required_artifacts.items.additionalProperties;
let caught=false;
try {host.parameterSchemaSpecToJsonSchema(mutant);} catch(error){caught=/additionalProperties must be explicitly/.test(error.message);}
if(!caught)throw new Error('native compiler failed to detect the Desktop activation regression');
console.log(JSON.stringify({compiled:definitions.map(t=>t.name),caughtMissingOpenness:true}));
`;
const run = spawnSync(executable, ['--expose-internals', '-e', native, desktop], {
  cwd: root, windowsHide: true, encoding: 'utf8', input: JSON.stringify(tools),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }, timeout: 30000,
});
assert.equal(run.status, 0, run.stderr || String(run.error));
const result = JSON.parse(run.stdout.trim());
assert.equal(result.compiled.length, tools.length);
assert(result.compiled.includes('operation_task') && result.caughtMissingOpenness);
console.log(`ok official Desktop compiler accepts ${tools.length} task/gate tool schemas`);
console.log('ok official Desktop compiler rejects the previous activation-breaking schema');
