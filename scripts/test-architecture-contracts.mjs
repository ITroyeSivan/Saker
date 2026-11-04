import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import { taskContextView } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { secondReviewError } from '../plugins/dsh-redteam-results/lib/store.js';

const context = {
  assets: [],
  checks: [],
  methods: [],
  requests: Array.from({ length: 20 }, (_, index) => ({
    id: 'request-' + index,
    revision: 'v1',
    endpoint: 'https://fixture.test/api/' + index,
    authContext: 'fixture',
    valid: true,
  })),
};

const first = taskContextView(context);
assert.equal(first.maxItems, 6);
assert.equal(first.limitBytes, 2048);
assert(Buffer.byteLength(first.text, 'utf8') <= 2048);
assert.match(first.text, /request-5/);
assert.doesNotMatch(first.text, /request-6/);
assert.equal((first.text.match(/^\[request\]/gm) || []).length, 6);
assert.match(taskContextView(context, { offset: first.nextOffset }).text, /request-6/);

assert.equal(secondReviewError('pentest', { status: 'pending' }, { status: 'verified' }), null);
assert.match(secondReviewError('pentest', { status: 'pending' },
  { status: 'verified', secondRating: 'high' }), /依据/);

console.log('ok architecture contracts: bounded index and optional independent review');
console.log('all architecture contracts passed');
