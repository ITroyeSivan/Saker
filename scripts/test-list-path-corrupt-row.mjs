import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { SITE_WORKER_SCHEMA, siteWorkerRows } from '../plugins/dsh-redteam-results/lib/site-workers.js';
import { BUSINESS_MATERIAL_SCHEMA, businessMaterialView } from '../plugins/dsh-redteam-results/lib/business-materials.js';
import { researchDetail } from '../plugins/dsh-redteam-results/lib/research.js';
import { CorruptRecordError } from '../plugins/dsh-redteam-results/lib/row-record.js';

// 列表路径上的坏行必须给出"哪张表、哪条会话"，而不是让整个列表以 Unexpected token 崩掉。
const home = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'saker-list-corrupt-'));
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
function test(label, fn) { try { fn(); console.log('ok ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }
const capture = fn => { try { fn(); return null } catch (error) { return error } };

try {
  await test('the worker list reports a corrupt row with its table and parent', () => {
    store.db.exec(SITE_WORKER_SCHEMA);
    store.db.prepare('INSERT INTO site_workers (parent_session, child_id, site, record) VALUES (?,?,?,?)')
      .run('parent-list', 'child-1', 'https://fixture.test', '{"broken"');
    const error = capture(() => siteWorkerRows(store, 'parent-list'));
    assert(error instanceof CorruptRecordError, 'expected the typed error, got ' + error);
    assert.equal(error.table, 'site_workers');
    assert.equal(error.rowKey, 'parent_session');
    assert.equal(error.rowId, 'parent-list');
  });

  await test('the business-material view reports a corrupt row the same way', () => {
    store.db.exec(BUSINESS_MATERIAL_SCHEMA);
    store.db.prepare('INSERT INTO business_materials (session_id, id, source_url, digest, record) VALUES (?,?,?,?,?)')
      .run('session-materials', 'm1', 'https://fixture.test/doc', 'digest', 'not json');
    const error = capture(() => businessMaterialView(store, 'session-materials'));
    assert(error instanceof CorruptRecordError, 'expected the typed error, got ' + error);
    assert.equal(error.table, 'business_materials');
    assert.equal(error.rowId, 'session-materials');
  });

  await test('the research detail list reports a corrupt observation', () => {
    store.db.prepare('INSERT OR REPLACE INTO research_hypotheses (session_id, id, direction_key, record) VALUES (?,?,?,?)')
      .run('session-research', 'h1', 'direction', JSON.stringify({ id: 'h1' }));
    store.db.prepare('INSERT OR REPLACE INTO research_observations (session_id, hypothesis_id, id, record) VALUES (?,?,?,?)')
      .run('session-research', 'h1', 'o1', '{"broken"');
    const error = capture(() => researchDetail(store, 'session-research', 'h1'));
    assert(error instanceof CorruptRecordError, 'expected the typed error, got ' + error);
    assert.equal(error.table, 'research_observations');
    assert.equal(error.rowId, 'session-research');
  });

  await test('healthy rows still list normally', () => {
    store.db.prepare('INSERT INTO site_workers (parent_session, child_id, site, record) VALUES (?,?,?,?)')
      .run('parent-good', 'child-2', 'https://good.test', JSON.stringify({ childId: 'child-2', state: 'running' }));
    assert.equal(siteWorkerRows(store, 'parent-good').length, 1);
  });
} finally {
  try { store.close?.() } catch { /* already closed */ }
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log('Fixture verification only: an isolated SQLite fixture, no host and no model.');
process.exitCode = failed ? 1 : 0;
