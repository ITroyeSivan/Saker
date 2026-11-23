import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { settingsView, saveTaskSettings } from '../plugins/dsh-redteam-results/lib/task-settings.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-knowledge-switch-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
const host = { maxWorkers: 8, modelAdmission: true, tokens: true };
const view = () => settingsView(store, 'sess', { host });
const save = (requestId, patch) => {
  const current = view();
  return saveTaskSettings(store, 'sess', {
    requestId,
    expected: {
      settingsRevision: current.settingsRevision,
      sceneRevision: current.sceneRevision,
      roundId: current.roundId,
    },
    patch,
  }, host);
};

try {
  assert.equal(view().effective.knowledge.enabled, false, 'new sessions default to knowledge off');
  assert.equal(view().effective.knowledge.strategy, 'web-first');
  assert.equal(fs.existsSync(path.join(home, 'redteam-results', 'knowledge', 'index-v1.db')), false,
    'reading settings does not create or open the knowledge index');

  let result = save('enable', { knowledge: { enabled: true, strategy: 'knowledge-only' } });
  assert.equal(result.settingsView.effective.knowledge.enabled, true);
  assert.equal(result.settingsView.effective.knowledge.strategy, 'knowledge-only');
  assert.equal(view().effective.knowledge.revision, 1);

  result = save('disable', { knowledge: { enabled: false } });
  assert.equal(result.settingsView.effective.knowledge.enabled, false);
  assert.equal(result.settingsView.effective.knowledge.strategy, 'knowledge-only',
    'turning the switch off retains the last strategy for later re-enable');
  assert.equal(view().effective.knowledge.revision, 2);

  assert.throws(() => save('bad-strategy', { knowledge: { strategy: 'model-decides' } }), /策略/);
  assert.throws(() => save('unknown', { knowledge: { directory: 'C:/secret' } }), /不支持/);

  const attempts = store.db.prepare('SELECT count(*) AS n FROM task_settings_requests').get().n;
  assert.equal(attempts, 2, 'invalid knowledge changes roll back without creating request rows');
  console.log('ok   knowledge defaults off, persists through unified settings and invalid values roll back');
} finally {
  store.close();
  fs.rmSync(home, { recursive: true, force: true });
}
