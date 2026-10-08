#!/usr/bin/env node
import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createEffectLab } from '../benchmarks/task-effects/lab.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = resolve(root, '../_ref/tmp');
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--case' || args[2] !== '--out') throw new Error('Usage: node scripts/start-task-effect-lab.mjs --case p1 --out ../_ref/tmp/task-effect-run');
mkdirSync(temp, { recursive: true });
const output = resolve(args[3]), rel = relative(realpathSync(temp), output);
if (!rel || rel.startsWith('..') || isAbsolute(rel) || existsSync(output)) throw new Error('Select a fresh child directory under workspace _ref/tmp');
// Resolve the nearest existing ancestor too, so an intermediate junction cannot escape temp.
let ancestor = dirname(output);
while (!existsSync(ancestor)) ancestor = dirname(ancestor);
const ancestorRel = relative(realpathSync(temp), realpathSync(ancestor));
if (ancestorRel.startsWith('..') || isAbsolute(ancestorRel)) throw new Error('Output ancestor escapes workspace temp');
const agentDirectory = join(output, 'agent'), controllerDirectory = join(output, 'controller');
mkdirSync(agentDirectory, { recursive: true }); mkdirSync(controllerDirectory, { recursive: true });
const lab = await createEffectLab(args[1]);
writeFileSync(join(agentDirectory, 'brief.json'), JSON.stringify(lab.brief(), null, 2));
console.log(JSON.stringify({ started: true, caseId: lab.caseId, runId: lab.runId, target: lab.origin, agentDirectory }));
const input = createInterface({ input: process.stdin });
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await lab.close();
  writeFileSync(join(controllerDirectory, 'audit.json'), JSON.stringify(lab.audit(), null, 2));
  input.close(); process.exitCode = 0;
}
input.on('line', async line => {
  try {
    const message = JSON.parse(line);
    if (message.action === 'request') console.log(JSON.stringify({ receipt: await lab.request(message.input) }));
    else if (message.action === 'grade') {
      const score = lab.grade(message.submission);
      writeFileSync(join(controllerDirectory, 'score.json'), JSON.stringify(score, null, 2));
      writeFileSync(join(controllerDirectory, 'audit.json'), JSON.stringify(lab.audit(), null, 2));
      console.log(JSON.stringify({ score }));
    } else if (message.action === 'stop') await stop();
    else throw new Error('unknown controller action');
  } catch (error) { console.log(JSON.stringify({ error: error.message })); }
});
process.on('SIGINT', stop); process.on('SIGTERM', stop);
setTimeout(stop, 30 * 60 * 1000).unref();
