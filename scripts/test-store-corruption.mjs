// 坏库自愈必须**保留原件**（v6 第 9.2 节）：主库、WAL、SHM 一起改名到备份旁边，
// 既不污染重建后的新库，也不丢掉可能唯一能找回的增量。
//
// 为什么单独测：以前的实现把 `-wal` / `-shm` 直接 `rmSync` 删掉——库能开，但用户的
// 未落盘增量永久消失，且没有任何提示。这里锁死“改名保留”这个行为。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { testTempRoot } from './lib/test-temp-root.mjs';

const boundary = testTempRoot(import.meta.url);
const scratch = mkdtempSync(join(boundary, 'store-corruption-'));
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

const corruptBytes = Buffer.alloc(512, 0x41); // 非 SQLite 头，够长以免被当成空库
const walBytes = Buffer.from('WAL-UNFLUSHED-INCREMENT', 'utf8');
const shmBytes = Buffer.from('SHM-SHARED-MEMORY', 'utf8');

try {
  const file = join(scratch, 'results.db');
  writeFileSync(file, corruptBytes);
  writeFileSync(file + '-wal', walBytes);
  writeFileSync(file + '-shm', shmBytes);

  test('a corrupt database is healed into a usable store without throwing', () => {
    const store = openStore(file);
    try {
      // 新库可用：能建表、能写能读。
      store.db.prepare('SELECT count(*) AS n FROM findings').get();
      assert.equal(existsSync(file), true, 'a fresh database file exists at the original path');
    } finally { store.close(); }
  });

  test('the corrupt original is preserved as a backup, byte for byte', () => {
    const backups = readdirSync(scratch).filter((name) => name.startsWith('results.db.corrupt-') && !/-wal$|-shm$/.test(name));
    assert.equal(backups.length, 1, 'exactly one corrupt backup was written');
    const backup = join(scratch, backups[0]);
    assert.deepEqual(readFileSync(backup), corruptBytes, 'the original bytes are intact in the backup');
  });

  test('WAL and SHM are renamed next to the backup, never deleted', () => {
    const backups = readdirSync(scratch).filter((name) => name.startsWith('results.db.corrupt-') && !/-wal$|-shm$/.test(name));
    const backup = join(scratch, backups[0]);
    assert.equal(existsSync(backup + '-wal'), true, 'the unflushed WAL increment is preserved');
    assert.equal(existsSync(backup + '-shm'), true, 'the shared-memory file is preserved');
    assert.deepEqual(readFileSync(backup + '-wal'), walBytes, 'WAL bytes are intact');
    assert.deepEqual(readFileSync(backup + '-shm'), shmBytes, 'SHM bytes are intact');
    assert.equal(existsSync(file + '-wal'), false, 'the WAL no longer sits beside the rebuilt database');
    assert.equal(existsSync(file + '-shm'), false, 'the SHM no longer sits beside the rebuilt database');
  });

  test('a healthy database is opened in place and never backed up', () => {
    const clean = join(scratch, 'clean.db');
    const first = openStore(clean);
    first.db.prepare('SELECT count(*) AS n FROM findings').get();
    first.close();
    const before = readdirSync(scratch).filter((name) => name.startsWith('clean.db.corrupt-'));
    assert.equal(before.length, 0, 'a valid database is not treated as corrupt');
    const second = openStore(clean);
    try { second.db.prepare('SELECT count(*) AS n FROM findings').get(); } finally { second.close(); }
    assert.equal(readdirSync(scratch).filter((name) => name.startsWith('clean.db.corrupt-')).length, 0);
  });
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
