import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-workbench-cross-'));
const dbPath = path.join(home, 'redteam-results', 'results.db');
const workerScript = fileURLToPath(new URL('./lib/workbench-command-worker.mjs', import.meta.url));
const stubUrl = new URL('./test-stub-register.mjs', import.meta.url).href;
const store = openStore(dbPath);
let failed = 0;
const run = (commandId, holdMs) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', stubUrl, workerScript, dbPath, commandId, String(holdMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve(JSON.parse(stdout.trim().split('\n').pop())) : reject(new Error(stderr || 'worker exit ' + code)));
});
try {
  startTaskPolicy(store, 'root-cross-process', { mode: 'regular', question: 'cross-process command', budget: { workers: 1 } });
  const [a, b] = await Promise.all([run('cmd-cross-process', 2500), run('cmd-cross-process', 2500)]);
  assert.equal([a, b].filter(row => row.ok && row.result?.ok !== false).length, 1, 'exactly one process executes the command');
  assert.equal([a, b].some(row => row.code === 'command-in-flight' || row.code === 'HOST_RESULT_UNKNOWN'), true, 'the other process reports in-flight/unknown instead of executing');
  const records = store.db.prepare("SELECT command_id,status FROM saker_command_records WHERE command_id='cmd-cross-process'").all();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'completed');
  console.log('ok   exactly one process executes a cross-process commandId');
  console.log('all cross-process workbench command tests passed');
} catch (error) {
  failed = 1;
  console.log('FAIL ' + (error.stack || error.message));
} finally {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
