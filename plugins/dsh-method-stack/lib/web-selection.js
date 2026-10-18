// Test-content selection; task ownership, revisions and writes live in the task
// API. Legacy per-mode JSON and old method-category keys are read-only migration
// sources — the UI may still send `group/id` until it is replaced, so we map
// those to the stable 17-item catalog here instead of touching every caller.
import path from 'node:path';
import { openStore } from '@dsh-external/dsh-redteam-results/store';
import { taskModuleSelection, saveTaskModules } from '@dsh-external/dsh-redteam-results/task-modules';
import { readLegacyModules } from './selection-config.js';
import { TEST_CONTENT_KEYS, LEGACY_METHOD_TO_CONTENT, testContentCatalog } from '@dsh-external/dsh-redteam-results/test-catalog';

const stableId = key => TEST_CONTENT_KEYS.includes(key) ? key : LEGACY_METHOD_TO_CONTENT[key];
function mapKeys(active, fallback) {
  if (!Array.isArray(active)) return { active: fallback, unknown: [] };
  const out = new Set(), unknown = [];
  for (const key of active) { const id = stableId(key); if (id) out.add(id); else unknown.push(key); }
  return { active: TEST_CONTENT_KEYS.filter(key => out.has(key)), unknown };
}

export function webCatalog(catalog) {
  // Keeps the `{group, methods:[{id,label,prompt}]}` shape the setting UI already
  // renders, but the keys are now the stable test-content ids. `prompt` is left
  // empty on purpose: this panel deliberately does not carry method bodies.
  return testContentCatalog().map(group => ({
    group: group.id,
    methods: group.items.map(item => ({ id: item.id, label: item.label, prompt: '' })),
  }));
}
function configuration(home, catalog, defaults) {
  return { keys: TEST_CONTENT_KEYS, defaults: mapKeys(defaults, undefined).active,
    legacy: (owner, mode) => readLegacyModules(home, owner, mode) };
}
function withStore(home, work) {
  const store = openStore(path.join(home, 'redteam-results/results.db'));
  try { return work(store); } finally { store.close(); }
}
export function webSelection(home, sessionId, catalog, defaults) {
  const config = configuration(home, catalog, defaults);
  if (sessionId === 'unbound-preview') return { owner: sessionId, mode: 'regular', inherited: false,
    active: mapKeys(defaults, config.keys).active, unavailable: [], rev: 0, policyRev: 0, available: true, backing: 'preview' };
  return withStore(home, store => taskModuleSelection(store, sessionId, config));
}
export function saveWebSelection(home, sessionId, mode, active, expectedRev, catalog, defaults, policyRev) {
  if (sessionId === 'unbound-preview') throw Error('请选择会话');
  const mapped = mapKeys(active, []);
  if (mapped.unknown.length) throw Error('只能选择当前可用的测试内容');
  return withStore(home, store => saveTaskModules(store, sessionId, { mode, active: mapped.active, rev: expectedRev, policyRev }, configuration(home, catalog, defaults)));
}
