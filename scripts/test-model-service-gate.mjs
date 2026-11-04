import assert from 'node:assert/strict';
import { createModelServiceGate, localModelServiceKey } from '../plugins/dsh-redteam-results/lib/model-budget.js';

const gate = createModelServiceGate();
const first = await gate.acquire('model-service:fixture', 1);
assert.equal(gate.stats()[0].active, 1);

const controller = new AbortController();
const cancelled = gate.acquire('model-service:fixture', 1, controller.signal);
assert.equal(gate.stats()[0].queued, 1);
controller.abort();
await assert.rejects(cancelled, /abort|cancel/i);
assert.equal(gate.stats()[0].queued, 0);

const next = gate.acquire('model-service:fixture', 1);
first.release();
const second = await next;
assert.equal(gate.stats()[0].active, 1);
second.release();
assert.deepEqual(gate.stats(), []);

const twoA = await gate.acquire('model-service:parallel', 2);
const twoB = await gate.acquire('model-service:parallel', 2);
assert.equal(gate.stats()[0].active, 2);
twoA.release();
twoB.release();
assert.deepEqual(gate.stats(), []);

assert.equal(localModelServiceKey({ provider: 'audit-local' }), null, 'a name alone cannot prove the service is local');
assert.match(localModelServiceKey({ provider: 'custom', baseURL: 'http://127.0.0.1:9000/v1' }) || '', /127\.0\.0\.1:9000/);
assert.equal(localModelServiceKey({ provider: 'opencode-go' }), null);
console.log('ok   local model service gate: default serial, queue cancellation, release, explicit concurrency');
console.log('ok   local service identity: provider config URL wins and names alone never imply locality');
