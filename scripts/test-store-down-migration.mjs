// 回退保护：库比本构建新时**先拒绝**，绝不能把版本号写回去。
//
// 为什么需要：`openStore` 原来无条件执行 `PRAGMA user_version = SCHEMA_VERSION`。
// 用户把 Saker 从新版本回退到旧版本时，旧构建打开新库会把"这份数据来自更新版本"
// 这条**唯一线索**抹掉 —— 之后新构建再打开会把它当成旧库，按旧结构去读新语义的列。
// 真正危险的不是读不懂，而是**读不懂还照写**。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, SchemaTooNewError, openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { testTempRoot } from './lib/test-temp-root.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundary = testTempRoot(import.meta.url);
const scratch = mkdtempSync(join(boundary, 'store-down-migration-'));

const readVersion = (file) => {
  const db = new DatabaseSync(file);
  try { return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? -1); }
  finally { db.close(); }
};
const writeVersion = (file, version) => {
  const db = new DatabaseSync(file);
  try { db.exec(`PRAGMA user_version = ${version}`); }
  finally { db.close(); }
};

let failed = 0;
async function test(label, fn) {
  try { await fn(); console.log('ok ' + label); }
  catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); }
}

try {
  await test('a database written by a newer build is refused instead of silently stamped down', () => {
    const file = join(scratch, 'newer.db');
    writeVersion(file, SCHEMA_VERSION + 1);
    let opened;
    const error = (() => { try { opened = openStore(file); return null; } catch (thrown) { return thrown; } })();
    // 保护缺失时 openStore 会正常返回：这里必须把句柄关掉，否则临时目录删不掉，
    // 失败原因会被"清理失败"盖住，还会在临时区留下垃圾（2026-10-11 实测过一次）。
    if (opened !== undefined) { try { opened.db.close(); } catch { /* 关不掉不影响断言结论 */ } }
    assert(error instanceof SchemaTooNewError, 'a newer database must be refused with the typed error');
    assert.equal(error.code, 'schema-too-new');
    assert.equal(error.storedVersion, SCHEMA_VERSION + 1);
    assert.equal(error.supportedVersion, SCHEMA_VERSION);
    assert(error.message.includes(String(SCHEMA_VERSION + 1)) && error.message.includes(String(SCHEMA_VERSION)),
      'the message must name both versions');
    assert(error.message.includes(file), 'the message must name the database path');
    assert.equal(readVersion(file), SCHEMA_VERSION + 1,
      'the newer version marker must survive the refusal — that marker is the only evidence of the newer build');
  });

  await test('an older database is upgraded and stamped to the current version', () => {
    const file = join(scratch, 'older.db');
    writeVersion(file, SCHEMA_VERSION - 1);
    const store = openStore(file);
    try {
      assert.equal(store.schemaVersion, SCHEMA_VERSION);
      assert.equal(readVersion(file), SCHEMA_VERSION);
    } finally { store.db.close(); }
  });

  await test('a fresh database opens at the current version and stays readable on reopen', () => {
    const file = join(scratch, 'fresh.db');
    const first = openStore(file);
    first.db.close();
    assert.equal(readVersion(file), SCHEMA_VERSION);
    const second = openStore(file);
    try { assert.equal(second.schemaVersion, SCHEMA_VERSION); }
    finally { second.db.close(); }
    assert.equal(readVersion(file), SCHEMA_VERSION, 'a current database must not be rewritten to another version');
  });
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

process.exitCode = failed ? 1 : 0;
