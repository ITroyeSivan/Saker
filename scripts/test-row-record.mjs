import assert from 'node:assert/strict';
import { CorruptRecordError, parseRowRecord } from '../plugins/dsh-redteam-results/lib/row-record.js';

let failed = 0;
function test(label, fn) { try { fn(); console.log('ok ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }
const capture = fn => { try { fn(); return null } catch (error) { return error } };

await test('a well-formed row parses and an absent row is null', () => {
  assert.deepEqual(parseRowRecord({ record: '{"a":1}' }, { table: 't' }), { a: 1 });
  assert.equal(parseRowRecord(null, { table: 't' }), null);
  assert.equal(parseRowRecord(undefined, { table: 't' }), null);
});

await test('a corrupt row raises a typed error naming the table and the row', () => {
  const error = capture(() => parseRowRecord({ record: '{not json', session_id: 'session-x' }, { table: 'task_policy' }));
  assert(error instanceof CorruptRecordError, 'expected CorruptRecordError, got ' + error);
  assert.equal(error.code, 'record-corrupt');
  assert.equal(error.name, 'CorruptRecordError');
  assert.equal(error.table, 'task_policy');
  assert.equal(error.rowId, 'session-x');
  assert.match(error.message, /task_policy/);
  assert.match(error.message, /session-x/);
  assert.doesNotMatch(error.message, /^Unexpected token/);
});

await test('an explicit id and a custom key are carried into the message', () => {
  const error = capture(() => parseRowRecord({ record: ']' }, { table: 'site_workers', key: 'parent_session', id: 'parent-7' }));
  assert.equal(error.rowId, 'parent-7');
  assert.equal(error.rowKey, 'parent_session');
  assert.match(error.message, /parent_session=parent-7/);
});

await test('an unknown row id still produces a locatable message', () => {
  const error = capture(() => parseRowRecord({ record: 'x' }, { table: 'task_flow_choice' }));
  assert.equal(error.rowId, '?');
  assert.match(error.message, /task_flow_choice/);
});

console.log('Fixture verification only: no store, host or model is touched.');
process.exitCode = failed ? 1 : 0;
