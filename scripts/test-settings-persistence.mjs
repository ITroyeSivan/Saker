import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { chooseTaskMode, startTaskPolicy, readTaskPolicy, archiveTaskRound } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { writeTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy-record.js';
import { writeSceneContext, readSceneContext } from '../plugins/dsh-redteam-results/lib/scene-context.js';
import { saveTaskSettings, readSettingsRequest, settingsView } from '../plugins/dsh-redteam-results/lib/task-settings.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-settings-'));
const host = { maxWorkers: 16, modelAdmission: true, tokens: true };
const request = (id, view, patch) => ({ requestId: id,
  expected: { settingsRevision: view.settingsRevision, sceneRevision: view.sceneRevision, roundId: view.roundId }, patch });
const save = (store, id, view, requestId, patch) => saveTaskSettings(store, id, request(requestId, view, patch), host);
const fresh = () => { const file = path.join(home, 'settings-' + Math.random().toString(36).slice(2) + '.db'); return { file, store: openStore(file) }; };
let checks = 0;
function ok(label) { checks += 1; console.log('ok ' + label); }

{
  const { file, store } = fresh();
  let view = settingsView(store, 'draft', { host });
  const result = save(store, 'draft', view, 'settings-7', {
    workers: 1, budget: { minutes: 7, toolCalls: 20, modelCalls: 5, tokens: 1000 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.settingsView.effective.budget.minutes, 7);
  store.close();
  const reopened = openStore(file);
  view = settingsView(reopened, 'draft', { host });
  assert.equal(view.effective.budget.minutes, 7);
  assert.equal(view.effective.budget.toolCalls, 20);
  assert.equal(view.effective.workers, 1);
  ok('A01 draft settings survive a real store close and reopen');
  reopened.close();
}

{
  const { store } = fresh();
  let view = settingsView(store, 'draft-invalid', { host });
  view = save(store, 'draft-invalid', view, 'settings-valid', { workers: 5, reporting: 'notable' }).settingsView;
  const before = readSettingsRequest(store, 'draft-invalid', 'settings-valid');
  assert.throws(() => save(store, 'draft-invalid', view, 'settings-invalid', {
    workers: 3, reporting: 'step', budget: { minutes: 0 },
  }), /1–10080|整数/);
  const after = settingsView(store, 'draft-invalid', { host });
  assert.equal(after.settingsRevision, view.settingsRevision);
  assert.equal(after.effective.workers, 5);
  assert.equal(after.effective.reporting, 'notable');
  assert.equal(readSettingsRequest(store, 'draft-invalid', 'settings-valid').settingsRevision,
    before.settingsRevision);
  view = save(store, 'draft-invalid', after, 'settings-clear', {
    budget: { minutes: null, toolCalls: null, modelCalls: null, tokens: null, unmeteredToolCalls: 0 },
  }).settingsView;
  for (const key of ['minutes', 'toolCalls', 'modelCalls', 'tokens']) assert.equal(view.effective.budget[key], null);
  assert.equal(view.effective.budget.unmeteredToolCalls, 0);
  assert.throws(() => save(store, 'draft-invalid', view, 'settings-unknown', { mystery: true }), /不支持/);
  ok('A02 invalid fields roll back atomically; clearing means null and zero remains a real cap');
  store.close();
}

{
  const { store } = fresh();
  let view = settingsView(store, 'inherit', { host });
  view = save(store, 'inherit', view, 'settings-inherit', {
    workers: 0, budget: { minutes: 7, toolCalls: 4, modelCalls: 3, unmeteredToolCalls: 0 },
  }).settingsView;
  chooseTaskMode(store, 'inherit', 'regular', {});
  assert.throws(() => startTaskPolicy(store, 'inherit', {
    mode: 'regular', question: 'fixture', budget: { toolCalls: 9 },
  }), /不能高于|上限/);
  const startedAt = Date.now();
  const policy = startTaskPolicy(store, 'inherit', {
    mode: 'regular', question: 'fixture', budget: { toolCalls: 3, minutes: 6 },
  }, startedAt);
  assert.equal(policy.budget.minutes, 6);
  assert.equal(policy.budget.toolCalls, 3);
  assert.equal(policy.budget.deadline, startedAt + 6 * 60000);
  assert.equal(policy.budget.modelCalls, 3);
  assert.equal(policy.budget.unmeteredToolCalls, 0);
  ok('A03 start paths inherit saved caps and may only tighten them');

  let caseView = settingsView(store, 'case-inherit', { host });
  save(store, 'case-inherit', caseView, 'case-budget', { budget: { toolCalls: 2, minutes: 3 } });
  const casePolicy = startTaskPolicy(store, 'case-inherit', {
    scenario: 'project', question: 'case fixture', target: 'https://case.test',
    budget: { toolCalls: 1 },
  });
  assert.equal(casePolicy.budget.toolCalls, 1);
  assert.equal(casePolicy.budget.minutes, 3);
  ok('A03 case execution inherits the same budget authority');
  store.close();
}

{
  const { store } = fresh();
  writeSceneContext(store, 'competition', 'competition', { presetId: 'ctf-solver' });
  const beforeScene = readSceneContext(store, 'competition', 'ctf-solver');
  let view = settingsView(store, 'competition', { host, sceneId: 'competition' });
  view = save(store, 'competition', view, 'competition-report', {
    reporting: 'notable', budget: { minutes: 20, toolCalls: 9 },
  }).settingsView;
  assert.equal(view.sceneRevision, beforeScene.sceneRevision, 'ordinary competition preferences do not change scene revision');
  const afterScene = readSceneContext(store, 'competition', 'ctf-solver');
  assert.equal(afterScene.sceneRevision, beforeScene.sceneRevision);
  assert.equal(afterScene.preferences.reporting, 'notable');
  assert.equal(afterScene.preferences.budget.minutes, 20);
  assert.equal(afterScene.preferences.budget.toolCalls, 9);
  assert.equal(afterScene.preferences.budget.startedAt, undefined, 'saving a cap does not start competition time');
  assert.throws(() => save(store, 'competition', view, 'competition-site', { allowedOrigins: [] }), /不支持/);
  ok('A07 competition saves omit website fields, preserve scene revision and do not start budget time');
  store.close();
}

{
  const { store } = fresh();
  chooseTaskMode(store, 'atomic', 'regular', {});
  startTaskPolicy(store, 'atomic', {
    mode: 'regular', question: 'atomic', target: 'https://one.test', budget: { toolCalls: 8 },
  });
  const before = readTaskPolicy(store, 'atomic');
  const beforeView = settingsView(store, 'atomic', { host });
  store.db.exec("CREATE TRIGGER fixture_fail BEFORE UPDATE ON task_policy BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;");
  assert.throws(() => save(store, 'atomic', beforeView, 'atomic-fail', {
    target: 'https://two.test', reporting: 'notable', budget: { toolCalls: 7 },
  }), /fixture write failure/);
  store.db.exec('DROP TRIGGER fixture_fail');
  const after = readTaskPolicy(store, 'atomic');
  assert.equal(after.target, before.target);
  assert.equal(after.reporting, before.reporting);
  assert.equal(after.budget.toolCalls, before.budget.toolCalls);
  assert.equal(settingsView(store, 'atomic', { host }).settingsRevision, beforeView.settingsRevision);
  ok('A08 scope, preference and budget commit atomically with one settings revision');
  store.close();
}

{
  const { store } = fresh();
  chooseTaskMode(store, 'conflict', 'regular', {});
  startTaskPolicy(store, 'conflict', {
    mode: 'regular', question: 'conflict', target: 'https://conflict.test', budget: { toolCalls: 8 },
  });
  const base = settingsView(store, 'conflict', { host });
  const first = save(store, 'conflict', base, 'conflict-a', { reporting: 'notable' });
  assert.equal(first.ok, true);
  assert.throws(() => save(store, 'conflict', base, 'conflict-b', { reporting: 'step' }), (error) =>
    error.code === 'settings-conflict');
  const policy = readTaskPolicy(store, 'conflict');
  const current = settingsView(store, 'conflict', { host });
  writeTaskPolicy(store, 'conflict', {
    ...policy, used: { ...policy.used, toolCalls: 2 },
  }, 'usage-observation');
  assert.equal(settingsView(store, 'conflict', { host }).settingsRevision, current.settingsRevision,
    'usage growth does not create a settings conflict');
  const progressed = save(store, 'conflict', settingsView(store, 'conflict', { host }), 'conflict-c', { workers: 2 });
  assert.equal(readTaskPolicy(store, 'conflict').used.toolCalls, 2, 'a save never rewrites newer usage');
  assert.equal(progressed.ok, true);
  ok('A09 stale settings conflict visibly; usage growth does not conflict or get overwritten');
  store.close();
}

{
  const { store } = fresh();
  let view = settingsView(store, 'idem', { host });
  const first = save(store, 'idem', view, 'same-request', { reporting: 'notable' });
  const replay = save(store, 'idem', view, 'same-request', { reporting: 'notable' });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.settingsRevision, first.settingsRevision);
  assert.throws(() => save(store, 'idem', view, 'same-request', { reporting: 'step' }), (error) =>
    error.code === 'settings-request-conflict');
  const recovered = readSettingsRequest(store, 'idem', 'same-request');
  assert.equal(recovered.status, 'committed');
  assert.equal(recovered.settingsRevision, first.settingsRevision);
  ok('A10 lost responses can be read back; same id with changed content is rejected');
  store.close();
}

{
  const { store } = fresh();
  chooseTaskMode(store, 'rounds', 'regular', {});
  startTaskPolicy(store, 'rounds', {
    mode: 'regular', question: 'rounds', target: 'https://rounds.test', budget: { toolCalls: 2 },
  });
  const first = settingsView(store, 'rounds', { host });
  const policy = readTaskPolicy(store, 'rounds');
  writeTaskPolicy(store, 'rounds', { ...policy, turnEndedAt: Date.now() }, 'turn-ended');
  archiveTaskRound(store, 'rounds', 'desktop-user');
  const second = settingsView(store, 'rounds', { host });
  assert.notEqual(second.roundId, first.roundId);
  assert.throws(() => save(store, 'rounds', first, 'old-round-save', { reporting: 'step' }), (error) =>
    error.code === 'settings-round-conflict');
  ok('A11 explicit new round changes roundId and rejects a late draft from the old round');
  store.close();
}

{
  const { store } = fresh();
  chooseTaskMode(store, 'inflight', 'regular', {});
  startTaskPolicy(store, 'inflight', {
    mode: 'regular', question: 'inflight', target: 'https://inflight.test', budget: { toolCalls: 8, minutes: 10 },
  });
  let policy = readTaskPolicy(store, 'inflight');
  writeTaskPolicy(store, 'inflight', { ...policy, used: { ...policy.used, toolCalls: 5 } }, 'fixture-used');
  let view = settingsView(store, 'inflight', { host });
  assert.throws(() => save(store, 'inflight', view, 'below-used', { budget: { toolCalls: 4 } }), /低于|不能低于/);
  const oldStart = Date.now() - 11 * 60000;
  policy = readTaskPolicy(store, 'inflight');
  writeTaskPolicy(store, 'inflight', { ...policy, startedAt: oldStart,
    budget: { ...policy.budget, minutes: 10, deadline: oldStart + 10 * 60000 } }, 'fixture-start');
  assert.throws(() => save(store, 'inflight', settingsView(store, 'inflight', { host }), 'expired-time', {
    budget: { minutes: 5 },
  }), /早于当前|已过期/);
  view = settingsView(store, 'inflight', { host });
  const tightened = save(store, 'inflight', view, 'permission-tighten', { allowTargetNetwork: false, readOnly: true });
  assert.equal(tightened.settingsView.effective.allowTargetNetwork, false);
  assert.equal(readTaskPolicy(store, 'inflight').startedAt, oldStart, 'permission changes do not restart the task');
  ok('A12 in-flight limits below used/pre-reserved or already expired values roll back; permissions tighten locally');
  store.close();
}

{
  const { store } = fresh();
  const view = settingsView(store, 'capability', { host: { maxWorkers: 8, modelAdmission: false, tokens: false } });
  assert.throws(() => saveTaskSettings(store, 'capability', request('no-admission', view, {
    budget: { modelCalls: 5 },
  }), { maxWorkers: 8, modelAdmission: false, tokens: false }), /准入/);
  assert.throws(() => saveTaskSettings(store, 'capability', request('no-token-counter', view, {
    budget: { tokens: 5000 },
  }), { maxWorkers: 8, modelAdmission: true, tokens: false }), /计数/);
  assert.equal(settingsView(store, 'capability', { host }).settingsRevision, 0);
  ok('A06 missing model admission or token counting rejects the whole save before configuration is written');
  store.close();
}

{
  const { store } = fresh();
  store.db.prepare('INSERT INTO task_flow_choice(session_id,record) VALUES(?,?)').run('legacy-draft', JSON.stringify({
    workflow: 'single', scenario: 'pentest', startMode: 'direct-test', interaction: 'auto', reporting: 'end',
    target: 'https://legacy.test', workers: 1, budget: { minutes: 12, toolCalls: 6, modelCalls: 2, tokens: 900 },
  }));
  let legacy = settingsView(store, 'legacy-draft', { host });
  assert.equal(legacy.effective.target, 'https://legacy.test');
  assert.equal(legacy.effective.budget.minutes, 12);
  assert.equal(legacy.effective.budget.tokens, 900);
  assert.equal(legacy.effective.knowledge.enabled, false);
  writeSceneContext(store, 'legacy-competition', 'competition', { presetId: 'ctf-solver' });
  const row = store.db.prepare('SELECT record FROM scene_contexts WHERE session_id=?').get('legacy-competition');
  const record = JSON.parse(row.record);
  store.db.prepare('UPDATE scene_contexts SET record=? WHERE session_id=?')
    .run(JSON.stringify({ ...record, knowledgeEnabled: true }), 'legacy-competition');
  legacy = settingsView(store, 'legacy-competition', { host, sceneId: 'competition' });
  assert.equal(legacy.effective.knowledge.enabled, true);
  assert.equal(legacy.effective.knowledge.strategy, 'knowledge-only');
  assert.match(legacy.warnings.join(' '), /旧比赛资料|统一设置/);
  store.db.prepare('INSERT INTO task_flow_choice(session_id,record) VALUES(?,?)').run('bad-choice', '{broken');
  const bad = settingsView(store, 'bad-choice', { host });
  assert.match(bad.warnings.join(' '), /损坏|恢复/);
  assert.equal(bad.effective.target, '', 'bad JSON never becomes an expanded empty scope');
  ok('A39 legacy budgets remain readable; old competition knowledge stays scoped and bad records are visible without widening access');
  store.close();
}

console.log(`\n${checks} settings checks passed`);
