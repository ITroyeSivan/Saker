// The task owner is the only writer. Prepared choices move into the task policy
// at start; archived rounds retain their old policy and seed a new choice.
//
// 迁移后：后台只按 test-catalog 的 17 项稳定 ID 判断，不再绑定方法分类键。
import { parseRowRecord } from './row-record.js';
import { policyRecord, writeTaskPolicy, taskTransaction, taskEvent } from './task-policy-record.js';
import { normalizeTestContent, unknownTestContent, migrateLegacyContent } from './test-catalog.js';
const modes = new Set(['regular', 'nday', '0day']);
function checkedActive(active) {
  if (!Array.isArray(active) || active.some(key => typeof key !== 'string')) throw Error('测试内容设置格式错误');
  return normalizeTestContent(active);
}
/** 旧方法键先迁移到稳定 ID；目录外的旧键保留在 unavailable 里，不悄悄当成允许。 */
function migrateActive(active) {
  if (!Array.isArray(active)) return { active: [], unknown: [] };
  const { mapped, unknown } = migrateLegacyContent(active);
  return { active: mapped, unknown };
}
export function moduleDirection(store, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 2000) throw Error('需要有效会话');
  let owner = sessionId, policy, inherited = false;
  const seen = new Set();
  while (true) {
    if (seen.has(owner)) throw Error('任务继承关系有循环');
    seen.add(owner); policy = policyRecord(store, owner);
    const parent = policy?.parentSession || store.db.prepare('SELECT parent_session FROM site_workers WHERE child_id=?').get(owner)?.parent_session;
    if (!parent) break;
    inherited = true; owner = parent;
  }
  if (inherited && !policy) throw Error('主任务不存在，无法确认测试模块');
  const mode = policy?.mode || store.db.prepare('SELECT mode FROM task_choice WHERE session_id=?').get(owner)?.mode || 'regular';
  if (!modes.has(mode)) throw Error('任务方向无法识别');
  return { owner, mode, inherited, policy };
}
function choiceRecord(store, owner) {
  const row = store.db.prepare('SELECT record FROM task_module_choices WHERE session_id=?').get(owner);
  if (!row) return null;
  const record = parseRowRecord(row, { table: 'task_module_choices', id: owner });
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw Error('task_module_choices 任务模块记录格式错误：' + owner);
  return record;
}
function putChoice(store, owner, record) {
  store.db.prepare('INSERT INTO task_module_choices(session_id,record,updated_at) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record,updated_at=excluded.updated_at')
    .run(owner, JSON.stringify(record), new Date().toISOString());
}
function selection(store, sessionId, config) {
  const direction = moduleDirection(store, sessionId), { owner, mode, inherited } = direction;
  let record = direction.policy;
  if (!record || !Array.isArray(record.modules)) {
    const prepared = choiceRecord(store, owner);
    const legacy = prepared ? null : config.legacy?.(owner, mode);
    const source = prepared?.modules ?? legacy?.active ?? config.defaults ?? config.keys;
    const migrated = migrateActive(source);
    const modules = migrated.active;
    const modulesRev = prepared?.modulesRev ?? legacy?.rev ?? 1;
    if (!Number.isSafeInteger(modulesRev) || modulesRev < 1) throw Error('测试模块修订号无效');
    if (record) {
      record = writeTaskPolicy(store, owner, { ...record, modules, modulesRev, modulesUnknown: migrated.unknown }, 'modules-initialized', { source: prepared ? 'prepared-choice' : legacy ? 'legacy-selection' : 'defaults' });
      store.db.prepare('DELETE FROM task_module_choices WHERE session_id=?').run(owner);
    } else if (!prepared) {
      record = { modules, modulesRev, policyRev: 1 };
      putChoice(store, owner, record);
      taskEvent(store, owner, 1, 'modules-initialized', { source: legacy ? 'legacy-selection' : 'defaults' });
    } else record = prepared;
  }
  const active = checkedActive(record.modules), known = new Set(config.keys);
  if (!Number.isSafeInteger(record.modulesRev ?? 1) || (record.modulesRev ?? 1) < 1 || !Number.isSafeInteger(record.policyRev ?? 0) || (record.policyRev ?? 0) < 0) throw Error('任务模块修订号无效');
  const unavailable = [...new Set([...active.filter(key => !known.has(key)), ...(Array.isArray(record.modulesUnknown) ? record.modulesUnknown : []), ...unknownTestContent(record.modules)])];
  return { owner, mode, inherited, active, unavailable,
    rev: record.modulesRev ?? 1, policyRev: record.policyRev ?? 0, available: true, backing: direction.policy ? 'task' : 'prepared' };
}
export function taskModuleSelection(store, sessionId, config) {
  return taskTransaction(store, () => selection(store, sessionId, config));
}
export function saveTaskModules(store, sessionId, input, config) {
  return taskTransaction(store, () => {
    const current = selection(store, sessionId, config);
    if (current.inherited) throw Error('子任务沿用主任务的测试模块，请在主任务修改');
    const conflict = message => { throw Object.assign(Error(message), { code: 'task-module-conflict', details: { current } }); };
    if (input.mode !== current.mode) conflict('任务方向已变化，请刷新后重试');
    if (input.rev !== current.rev) conflict('其他窗口已修改模块，请刷新后重试');
    if (input.policyRev !== current.policyRev) conflict('任务状态已变化，请刷新后重试');
    if (!Array.isArray(input.active) || input.active.some(key => typeof key !== 'string')) throw Error('测试内容设置格式错误');
    const allowed = new Set(config.keys);
    if (input.active.some(key => !allowed.has(key))) throw Error('只能选择当前可用的测试内容');
    const active = checkedActive(input.active);
    const previous = [...current.active, ...current.unavailable];
    const detail = { modulesRev: current.rev + 1, added: active.filter(key => !previous.includes(key)), removed: previous.filter(key => !active.includes(key)) };
    if (current.backing === 'task') {
      const policy = policyRecord(store, current.owner);
      writeTaskPolicy(store, current.owner, { ...policy, modules: active, modulesRev: current.rev + 1 }, 'modules-changed', detail);
    } else {
      putChoice(store, current.owner, { modules: active, modulesRev: current.rev + 1, policyRev: current.policyRev + 1 });
      taskEvent(store, current.owner, current.policyRev + 1, 'modules-changed', detail);
    }
    return selection(store, sessionId, config);
  });
}
export function adoptPreparedModules(store, sessionId) {
  const prepared = choiceRecord(store, sessionId);
  if (!prepared) return {};
  const migrated = migrateActive(prepared.modules);
  store.db.prepare('DELETE FROM task_module_choices WHERE session_id=?').run(sessionId);
  return { modules: migrated.active, modulesUnknown: migrated.unknown, modulesRev: prepared.modulesRev, policyRev: prepared.policyRev };
}
export function retainRoundModules(store, sessionId, policy) {
  if (!Array.isArray(policy.modules)) return;
  putChoice(store, sessionId, { modules: checkedActive(policy.modules), modulesRev: policy.modulesRev ?? 1, policyRev: (policy.policyRev ?? 0) + 1 });
  taskEvent(store, sessionId, (policy.policyRev ?? 0) + 1, 'round-archived', { modulesRev: policy.modulesRev ?? 1 });
}
export function bumpPreparedModules(store, sessionId) {
  const prepared = choiceRecord(store, sessionId);
  if (!prepared) return;
  const policyRev = prepared.policyRev + 1;
  putChoice(store, sessionId, { ...prepared, policyRev });
  taskEvent(store, sessionId, policyRev, 'task-options-changed', {});
}
