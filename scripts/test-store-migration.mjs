import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyColumnMigration, openStore, SCHEMA_VERSION } from '../plugins/dsh-redteam-results/lib/store.js';

let failed = 0;
function test(label, fn) { try { fn(); console.log('ok ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }
const capture = fn => { try { fn(); return null } catch (error) { return error } };

await test('only a duplicate column may be ignored; every other failure propagates', () => {
  assert.equal(applyColumnMigration({ exec: () => {} }, 'findings', 'impact'), 'added');
  assert.equal(applyColumnMigration({ exec: () => { throw new Error('duplicate column name: impact') } }, 'findings', 'impact'), 'existing');
  const locked = capture(() => applyColumnMigration({ exec: () => { throw new Error('database is locked') } }, 'findings', 'impact'));
  assert(locked, 'a locked database must not be swallowed as "column exists"');
  assert.match(locked.message, /findings/);
  assert.match(locked.message, /impact/);
  assert.match(locked.message, /database is locked/);
  const full = capture(() => applyColumnMigration({ exec: () => { throw new Error('database or disk is full') } }, 'findings', 'cwe'));
  assert.match(full.message, /disk is full/);
});

await test('re-opening an existing store adds nothing and stamps the schema version', () => {
  const home = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'saker-store-migration-'));
  const file = path.join(home, 'redteam-results', 'results.db');
  try {
    const first = openStore(file);
    try {
      assert.equal(first.schemaVersion, SCHEMA_VERSION);
      // 新库的表结构已含全部列，所以逐列 ALTER 全部命中"已存在"，一个也不该新增。
      assert.equal(first.migration.added, 0, 'a fresh database must not need any ALTER');
      assert(first.migration.existing > 0, 'the migration loop must still run over every legacy column');
      assert.equal(Object.values(first.db.prepare('PRAGMA user_version').get())[0], SCHEMA_VERSION);
    } finally { first.close(); }
    const second = openStore(file);
    try {
      assert.equal(second.migration.added, 0, 'a second open must not re-add anything');
      assert(second.migration.existing > 0);
      assert.equal(Object.values(second.db.prepare('PRAGMA user_version').get())[0], SCHEMA_VERSION);
      assert.equal(Object.values(second.db.prepare('SELECT COUNT(*) AS n FROM findings').get())[0], 0);
    } finally { second.close(); }
  } finally {
    // SQLite 关库后 WAL/SHM 可能还被短暂持有，直接删会偶发 EPERM。
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

await test('a legacy database missing a column is upgraded and the column becomes usable', () => {
  const home = fs.mkdtempSync(path.join(process.env.TEMP ?? os.tmpdir(), 'saker-store-legacy-'));
  const file = path.join(home, 'redteam-results', 'results.db');
  try {
    const created = openStore(file);
    try { created.db.exec('ALTER TABLE findings DROP COLUMN impact'); }
    finally { created?.close?.(); }
    let upgraded;
    try {
      upgraded = openStore(file);
      assert.equal(upgraded.migration.added, 1, 'exactly the missing column must be added');
      const columns = upgraded.db.prepare('PRAGMA table_info(findings)').all().map(row => row.name);
      assert(columns.includes('impact'), 'the legacy column must be present again');
    } finally { upgraded?.close?.(); }
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

console.log('Fixture verification only: an isolated SQLite file, no host and no model call.');
process.exitCode = failed ? 1 : 0;
