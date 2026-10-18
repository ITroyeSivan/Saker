// 更新前备份（v6 第 13 节）：配置/MCP/匹配构建必须留档，数据目录要有清单；
// 备份只读原文件，不改动被备份的东西。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDesktopProfile, inspectDesktopBackup, restoreDesktopProfile, BACKUP_SCHEMA } from './lib/desktop-backup.mjs';

let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-desktop-backup-'));
const profile = path.join(home, 'profiles', 'desktop');

try {
  fs.mkdirSync(profile, { recursive: true });
  const manifest = { name: 'dsh-saker', dependencies: { '@dsh-external/dsh-redteam-results': 'file:redteam.tgz', dshsaker: 'file:saker.tgz' },
    dsh: { profile: { bundles: ['@dsh-external/dsh-redteam-results', 'dsh-saker'] } } };
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- id: mcp-studio\n  name: "@dsh-external/dsh-mcp-studio"\n  config:\n    servers:\n      - id: srv-sec-burp\n        enabled: true\n');
  fs.mkdirSync(path.join(home, 'sessions', 'ws-a'), { recursive: true });
  fs.writeFileSync(path.join(home, 'sessions', 'ws-a', 'session.json'), '{"id":"s1"}');
  fs.mkdirSync(path.join(home, 'redteam-results'), { recursive: true });
  fs.writeFileSync(path.join(home, 'redteam-results', 'results.db'), 'SQLite format 3\u0000'.padEnd(64, '\u0000'));
  const before = Object.fromEntries(['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(name => [name, sha(path.join(profile, name))]));

  test('配置与 MCP 被逐字节复制，且记录更新前的依赖与已启用插件', () => {
    const { directory, record } = backupDesktopProfile({ home, now: 1_760_000_000_000 });
    assert.equal(record.schema, BACKUP_SCHEMA);
    assert.equal(directory, path.join(home, 'backups', 'desktop-2025-10-09T08-53-20-000Z'));
    assert.deepEqual(record.files.map(file => file.name).sort(), ['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml']);
    for (const file of record.files) {
      const copy = path.join(directory, 'profile', file.name);
      assert.equal(sha(copy), before[file.name], file.name + ' 必须逐字节一致');
      assert.equal(file.sha256, before[file.name]);
    }
    // 匹配构建：回退时要知道装回哪一套。
    assert.equal(record.previousDependencies['dshsaker'], 'file:saker.tgz');
    assert.deepEqual(record.previousBundles, ['@dsh-external/dsh-redteam-results', 'dsh-saker']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'backup.json'), 'utf8')).schema, BACKUP_SCHEMA);
    // 备份是只读操作。
    for (const [name, digest] of Object.entries(before)) assert.equal(sha(path.join(profile, name)), digest, name + ' 不能被备份改动');
  });

  test('默认只登记数据目录（存在性与字节数），不整体复制', () => {
    const { directory, record } = backupDesktopProfile({ home, now: 1_760_000_001_000 });
    const sessions = record.data.find(entry => entry.path === 'sessions');
    const redteam = record.data.find(entry => entry.path === 'redteam-results');
    assert.equal(sessions.present, true); assert(sessions.bytes > 0); assert.equal(sessions.copied, false);
    assert.equal(redteam.present, true); assert(redteam.bytes >= 64);
    assert.equal(fs.existsSync(path.join(directory, 'data')), false, '默认不复制数据');
    assert.equal(record.data.find(entry => entry.path === 'storages').present, false);
  });

  test('--backup-data 时把数据也复制一份，字节数与源一致', () => {
    const { directory, record } = backupDesktopProfile({ home, now: 1_760_000_002_000, includeData: true });
    const redteam = record.data.find(entry => entry.path === 'redteam-results');
    assert.equal(redteam.copied, true);
    const copied = path.join(directory, 'data', 'redteam-results', 'results.db');
    assert.equal(fs.existsSync(copied), true);
    assert.equal(fs.statSync(copied).size, fs.statSync(path.join(home, 'redteam-results', 'results.db')).size);
    assert.equal(sha(copied), sha(path.join(home, 'redteam-results', 'results.db')));
  });

  test('档案没初始化时明确拒绝，不做半截备份', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-desktop-backup-empty-'));
    try {
      assert.throws(() => backupDesktopProfile({ home: empty }), /先打开一次 Desktop/);
      assert.equal(fs.existsSync(path.join(empty, 'backups')), false);
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  });
  // ── 回退：程序与数据格式分别核对（v6 第 13 节）──────────────────────────────
  test('回退前自检：配置副本逐字节对得上记录、数据副本认得出格式', () => {
    const { directory } = backupDesktopProfile({ home, now: 1_760_000_003_000, includeData: true });
    const report = inspectDesktopBackup(directory);
    assert.deepEqual(report.problems, []);
    assert.equal(report.files.length, 3);
    assert.deepEqual(report.data.filter(entry => entry.copied).map(entry => entry.path).sort(), ['redteam-results', 'sessions']);
  });

  test('配置副本被改过时自检必须报出来，不能把坏档案盖回去', () => {
    const { directory } = backupDesktopProfile({ home, now: 1_760_000_004_000, includeData: true });
    fs.appendFileSync(path.join(directory, 'profile', 'package.json'), '\n');
    const report = inspectDesktopBackup(directory);
    assert(report.problems.some(problem => problem.includes('配置副本与记录不一致：package.json')), report.problems.join('; '));
    assert.throws(() => restoreDesktopProfile({ home, directory }), /备份档案自检未通过/);
  });

  test('数据副本格式不对（不是 SQLite）时自检必须报出来', () => {
    const { directory } = backupDesktopProfile({ home, now: 1_760_000_005_000, includeData: true });
    fs.writeFileSync(path.join(directory, 'data', 'redteam-results', 'results.db'), 'not-a-sqlite-file');
    const report = inspectDesktopBackup(directory);
    assert(report.problems.some(problem => problem.includes('不是 SQLite 文件')), report.problems.join('; '));
  });

  test('回退默认只出方案、不写文件；apply 时恢复配置与数据并留下回退前快照', () => {
    const { directory } = backupDesktopProfile({ home, now: 1_760_000_006_000, includeData: true });
    const original = Object.fromEntries(['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(name => [name, sha(path.join(profile, name))]));
    const dbPath = path.join(home, 'redteam-results', 'results.db');
    const dbBefore = sha(dbPath);
    // 制造「更新之后」的状态：配置与数据都被改过。
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-saker', dependencies: { changed: 'file:new.tgz' } }, null, 2));
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- id: changed\n');
    fs.writeFileSync(dbPath, 'SQLite format 3\u0000'.padEnd(128, '\u0000'));
    const changedCordis = sha(path.join(profile, 'cordis.patch.yml'));
    const planned = restoreDesktopProfile({ home, directory, now: 1_760_000_007_000 });
    assert.equal(planned.applied, false);
    assert.equal(sha(path.join(profile, 'cordis.patch.yml')), changedCordis, 'dry run 不能写文件');
    assert.notEqual(sha(path.join(profile, 'package.json')), original['package.json'], 'dry run 不能悄悄恢复');
    const applied = restoreDesktopProfile({ home, directory, apply: true, now: 1_760_000_008_000 });
    assert.equal(applied.applied, true);
    for (const [name, digest] of Object.entries(original)) assert.equal(sha(path.join(profile, name)), digest, name + ' 必须恢复成备份时的字节');
    assert.equal(sha(dbPath), dbBefore, '数据副本也要恢复');
    const safety = path.join(applied.safety, 'profile');
    assert(fs.existsSync(path.join(safety, 'package.json')), '回退前必须先留一份当前配置');
    assert(fs.readFileSync(path.join(safety, 'package.json'), 'utf8').includes('changed'), '快照里应是回退前的版本');
    assert(applied.plan.rebuild.bundles.includes('dsh-saker'), '回退方案要带上匹配构建');
  });
  // 数据清单里既有目录也有单个文件：真机备份的 `profiles/desktop/node_modules/.modules.yaml`
  // 曾把「按目录遍历」的实现打成 ENOTDIR，回退直接跑不起来。
  test('数据清单里的单个文件也能备份、自检与恢复', () => {
    const modulesDir = path.join(profile, 'node_modules');
    fs.mkdirSync(modulesDir, { recursive: true });
    const modulesFile = path.join(modulesDir, '.modules.yaml');
    fs.writeFileSync(modulesFile, 'hoistPattern: []\n');
    const { directory } = backupDesktopProfile({ home, now: 1_760_000_009_000, includeData: true });
    const report = inspectDesktopBackup(directory);
    assert.deepEqual(report.problems, []);
    assert.equal(report.data.find(entry => entry.path === 'profiles/desktop/node_modules/.modules.yaml')?.copied, true);
    fs.writeFileSync(modulesFile, 'changed: true\n');
    restoreDesktopProfile({ home, directory, apply: true, now: 1_760_000_010_000 });
    assert.equal(fs.readFileSync(modulesFile, 'utf8'), 'hoistPattern: []\n');
  });
  test('合法 JSON 内容被改写也必须拒绝恢复，不只检查格式', () => {
    const { directory } = backupDesktopProfile({ home, now: 1_760_000_011_000, includeData: true });
    fs.writeFileSync(path.join(directory, 'data', 'sessions', 'ws-a', 'session.json'), '{"id":"wrong-session"}');
    assert(inspectDesktopBackup(directory).problems.some(problem => problem.includes('数据副本与记录不一致')));
    assert.throws(() => restoreDesktopProfile({ home, directory, apply: true }), /备份档案自检未通过/);
  });
  test('恢复真实 SQLite 时隔离新文件和残留 WAL，当前数据完整留档并能再恢复', () => {
    const dbPath = path.join(home, 'redteam-results', 'rollback.db');
    let db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE version(value INTEGER); INSERT INTO version VALUES(3)'); db.close();
    const { directory } = backupDesktopProfile({ home, now: 1_760_000_012_000, includeData: true });
    db = new DatabaseSync(dbPath); db.exec('UPDATE version SET value=4'); db.close();
    const extra = path.join(home, 'redteam-results', 'new-finding.json');
    const wal = dbPath + '-wal';
    fs.writeFileSync(extra, '{"new":true}'); fs.writeFileSync(wal, 'stale-wal-from-newer-version');
    fs.mkdirSync(path.join(home, 'attachments'), { recursive: true });
    fs.writeFileSync(path.join(home, 'attachments', 'new.txt'), 'new attachment');
    const restored = restoreDesktopProfile({ home, directory, apply: true, now: 1_760_000_013_000 });
    assert(!fs.existsSync(extra)); assert(!fs.existsSync(wal));
    assert(!fs.existsSync(path.join(home, 'attachments')), '备份时不存在的数据不留在旧程序旁边');
    db = new DatabaseSync(dbPath); assert.equal(db.prepare('SELECT value FROM version').get().value, 3); db.close();
    assert.equal(fs.readFileSync(path.join(restored.safety, 'data', 'redteam-results', 'new-finding.json'), 'utf8'), '{"new":true}');
    assert.deepEqual(inspectDesktopBackup(restored.safety).problems, []);
    restoreDesktopProfile({ home, directory: restored.safety, apply: true, now: 1_760_000_014_000 });
    assert(fs.existsSync(extra)); assert(fs.existsSync(wal));
    assert.equal(fs.readFileSync(path.join(home, 'attachments', 'new.txt'), 'utf8'), 'new attachment');
  });
  test('上传的 JSON 片段和非 SQLite .db 文件按原样备份恢复，不误判为产品数据损坏', () => {
    const attachments = path.join(home, 'attachments');
    fs.mkdirSync(attachments, { recursive: true });
    fs.writeFileSync(path.join(attachments, 'partial.json'), '{"unfinished":');
    fs.writeFileSync(path.join(attachments, 'opaque.db'), 'a user supplied binary database');
    const { directory } = backupDesktopProfile({ home, now: 1_760_000_015_000, includeData: true });
    assert.deepEqual(inspectDesktopBackup(directory).problems, []);
    fs.writeFileSync(path.join(attachments, 'partial.json'), 'changed');
    restoreDesktopProfile({ home, directory, apply: true, now: 1_760_000_016_000 });
    assert.equal(fs.readFileSync(path.join(attachments, 'partial.json'), 'utf8'), '{"unfinished":');
    assert.equal(fs.readFileSync(path.join(attachments, 'opaque.db'), 'utf8'), 'a user supplied binary database');
  });
} finally { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); }
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
