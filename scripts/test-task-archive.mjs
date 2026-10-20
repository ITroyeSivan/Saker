import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, registerFinding } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, readTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { recordKnowledgeUsage } from '../plugins/dsh-redteam-results/lib/knowledge-usage.js';
import { createProjectRun, transitionProjectRun, defineProjectChecks, recordProjectCheck, upsertProjectSource, beginProjectAction, finishProjectAction } from '../plugins/dsh-redteam-results/lib/project-store.js';
import { exportTaskArchive, verifyTaskArchive, importTaskArchive, TASK_ARCHIVE_SCHEMA } from '../plugins/dsh-redteam-results/lib/task-archive.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-task-archive-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };
try {
  startTaskPolicy(store, 'src', { mode: 'regular', question: '归档用例', target: 'https://app.example.test', budget: { toolCalls: 5 } });
  registerFinding(store, 'src', 'pentest', { title: '归档发现', severity: 'high', target: 'https://app.example.test', summary: 'fixture' });
  saveTaskContext(store, 'src', { assets: [{ id: 'a1', url: 'https://app.example.test', inScope: true, reachable: true }], requests: [], checks: [] });
  recordKnowledgeUsage(store, 'src', { trigger: 'knowledge_search', query: 'x', docPath: 'sqli.md', contentBytes: 10 });
  // 必要原文与引用：归档必须带上它们，恢复后仍可读（第 9.2 节）。
  store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
    .run('src', 'material-1', 'https://app.example.test/static/app.js', 'a'.repeat(64),
      JSON.stringify({ id: 'material-1', file: 'app.js', sourceUrl: 'https://app.example.test/static/app.js', digest: 'a'.repeat(64), original: 'const token = "REDACTED-FIXTURE";' }));
  store.db.prepare('INSERT INTO task_context_records(session_id,kind,record_id,version,record) VALUES(?,?,?,?,?)')
    .run('src', 'request', 'r1', 'v1', JSON.stringify({ id: 'r1', version: 'v1', request: 'GET /api/orders HTTP/1.1\r\nHost: app.example.test\r\n\r\n', response: 'HTTP/1.1 200 OK\r\n\r\n[]' }));

  test('an archive is a consistent snapshot with schema version, counts and per-section digests', () => {
    const archive = exportTaskArchive(store, 'src');
    assert.equal(archive.manifest.schema, TASK_ARCHIVE_SCHEMA);
    assert.equal(typeof archive.manifest.schemaVersion, 'number');
    assert.equal(archive.manifest.secretsExcluded, true, 'secrets are excluded from a backup');
    assert.equal(archive.manifest.restoredState, 'unconfirmed');
    assert(archive.manifest.sections.task_policy >= 1);
    assert(archive.manifest.sections.findings >= 1);
    assert(archive.manifest.sections.knowledge_usage >= 1);
    assert(archive.manifest.sections.business_materials >= 1, '必要原文进归档');
    assert(archive.manifest.sections.task_context_records >= 1, '引用/请求原文进归档');
    assert.equal(Object.keys(archive.manifest.digests).length, Object.keys(archive.sections).length);
    assert.equal(verifyTaskArchive(archive).ok, true);
  });
  test('verification rejects a tampered section or a wrong schema', () => {
    const archive = exportTaskArchive(store, 'src');
    const tampered = JSON.parse(JSON.stringify(archive));
    tampered.sections.findings[0].title = 'invented';
    const verdict = verifyTaskArchive(tampered);
    assert.equal(verdict.ok, false); assert(verdict.problems.some(p => /摘要不一致/.test(p)));
    assert.equal(verifyTaskArchive({ manifest: { schema: 'other' }, sections: {} }).ok, false);
  });
  test('restoring writes a NEW task, marks it unconfirmed, and leaves the source untouched', () => {
    const archive = exportTaskArchive(store, 'src');
    const result = importTaskArchive(store, archive, { sessionId: 'restored-1' });
    assert.equal(result.sessionId, 'restored-1'); assert.equal(result.state, 'unconfirmed'); assert.equal(result.secretsNeedRebind, true);
    const restored = readTaskPolicy(store, 'restored-1');
    assert.equal(restored.restored.state, 'unconfirmed');
    assert.equal(restored.restored.fromSession, 'src');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM findings WHERE session_id=?').get('restored-1').n, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM knowledge_usage WHERE session_id=?').get('restored-1').n, 1);
    // 必要原文与引用一起恢复，内容一致。
    const material = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get('restored-1', 'material-1');
    assert(material, '原文记录恢复到新任务');
    assert.equal(JSON.parse(material.record).original, 'const token = "REDACTED-FIXTURE";');
    const record = store.db.prepare('SELECT record FROM task_context_records WHERE session_id=? AND record_id=?').get('restored-1', 'r1');
    assert(record && JSON.parse(record.record).request.includes('GET /api/orders'), '请求原文恢复到新任务');
    // 源任务不受影响
    assert.equal(readTaskPolicy(store, 'src').restored, undefined);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM findings WHERE session_id=?').get('src').n, 1);
  });
  test('项目运行、来源、检查和动作随任务归档并在新任务中恢复归属', () => {
    startTaskPolicy(store, 'project-src', { scenario: 'project', question: '项目归档', budget: { minutes: 10 } });
    upsertProjectSource(store, 'project-src', {
      sourceId: 'source-1', sourceRevision: 'r1', displayName: '要求.txt', parseState: 'ready',
      sections: [{ sectionId: 'lines-1-1', text: '检查接口' }],
    });
    const run = createProjectRun(store, 'project-src', {
      question: '项目归档', sourceSnapshot: [{ sourceId: 'source-1', sourceRevision: 'r1' }],
    });
    const running = transitionProjectRun(store, 'project-src', run.runId, 'running', run.controlRev);
    const [check] = defineProjectChecks(store, 'project-src', run.runId, [{ checkId: 'check-1', requirement: '检查接口' }]);
    const begun = beginProjectAction(store, 'project-src', run.runId, check.checkId, { executionState: 'queued' });
    finishProjectAction(store, 'project-src', run.runId, begun.action.actionId, { executionState: 'failed', error: '归档样本' });
    recordProjectCheck(store, 'project-src', run.runId, check.checkId, { executionState: 'ended', verdict: 'not_found', checkedContent: '未发现问题' });
    const archive = exportTaskArchive(store, 'project-src');
    for (const table of ['project_runs', 'project_sources', 'project_checks', 'project_actions']) assert(archive.manifest.sections[table] >= 1, table);
    const restored = importTaskArchive(store, archive, { sessionId: 'restored-project' });
    assert.equal(restored.sessionId, 'restored-project');
    const restoredRun = store.db.prepare('SELECT record FROM project_runs WHERE session_id=? AND run_id=?').get('restored-project', running.runId);
    assert(restoredRun);
    const runRecord = JSON.parse(restoredRun.record);
    assert.equal(runRecord.sessionId, 'restored-project', 'run JSON 归属必须随新任务重写');
    const restoredCheck = store.db.prepare('SELECT record FROM project_checks WHERE session_id=? AND check_id=?').get('restored-project', 'check-1');
    assert(restoredCheck && JSON.parse(restoredCheck.record).sessionId === 'restored-project');
  });
  test('restoring never overwrites an existing task and refuses an invalid archive', () => {
    const archive = exportTaskArchive(store, 'src');
    assert.throws(() => importTaskArchive(store, archive, { sessionId: 'src' }), /不要在已有数据上覆盖/);
    const broken = JSON.parse(JSON.stringify(archive));
    broken.manifest.digests.findings = 'deadbeef';
    assert.throws(() => importTaskArchive(store, broken, { sessionId: 'restored-2' }), /归档校验失败/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task_policy WHERE session_id=?').get('restored-2').n, 0, 'a rejected archive writes nothing');
  });
} finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
