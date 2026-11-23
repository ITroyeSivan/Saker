import { createHash } from 'node:crypto';
import { parseRowRecord } from './row-record.js';
import { sceneRootSession, readSceneContext } from './scene-context.js';
import { bumpSettingsRevision, taskTransaction, writeTaskPolicy } from './task-policy-record.js';
import { taskElapsed } from './task-duration.js';
import { normalizeInteraction, reportingFor } from './interaction.js';
import { normalizeModelChoice } from './model-choice.js';
import { normalizeRequestRate, normalizeRequestConcurrency } from './request-pacing.js';
import { normalizeTaskScope } from './task-scope.js';
import { normalizeTaskFlow } from './task-flow.js';

export const SETTINGS_SCHEMA_VERSION = 1;
export const DEFAULT_REFERENCE_STRATEGY = 'web-first';
export const REFERENCE_STRATEGIES = Object.freeze(['web-first', 'knowledge-first', 'knowledge-only']);
const TASK_MODES = new Set(['regular', 'nday', '0day']);
const BUDGET_LIMITS = Object.freeze({
  minutes: [1, 10080],
  toolCalls: [1, 10000],
  modelCalls: [1, 10000],
  tokens: [1, 1_000_000_000_000],
  unmeteredToolCalls: [0, 1000],
});
const BASE_FIELDS = ['interaction', 'reporting', 'explain', 'workers', 'workerModel', 'reviewModel',
  'reportModel', 'budget', 'modelConcurrency', 'knowledge'];
const SITE_FIELDS = ['target', 'scope', 'allowedOrigins', 'allowTargetNetwork', 'readOnly',
  'excludedPaths', 'requestRatePerMinute', 'requestConcurrency', 'direction'];
const COMPETITION_FIELDS = BASE_FIELDS;

const FIELD_LABELS = Object.freeze({
  interaction: '什么时候问我', reporting: '什么时候汇报', explain: '解释原理',
  workers: '助手上限', workerModel: '助手模型', reviewModel: '复核模型', reportModel: '报告模型',
  target: '测试范围', scope: '范围规则', allowedOrigins: '允许来源',
  allowTargetNetwork: '允许访问网站', readOnly: '仅发送 GET/HEAD', excludedPaths: '排除路径',
  requestRatePerMinute: '请求速率', requestConcurrency: '请求并发', direction: '测试重点',
  modelConcurrency: '本地模型并发', 'budget.minutes': '时间上限',
  'budget.toolCalls': '工具调用上限', 'budget.modelCalls': '模型调用上限',
  'budget.tokens': '模型 token 上限', 'budget.unmeteredToolCalls': '未计量通道上限',
  'knowledge.enabled': '知识查询', 'knowledge.strategy': '知识查询策略',
});

function nowIso() { return new Date().toISOString(); }
function parseRecord(row, fallback = null) {
  if (!row) return fallback;
  try {
    const value = JSON.parse(row.record);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch { return fallback; }
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
}
function stableJson(value) { return JSON.stringify(stableValue(value)); }
function digest(value) { return createHash('sha256').update(stableJson(value)).digest('hex'); }
function same(a, b) { return stableJson(a) === stableJson(b); }
function validRequestId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('requestId 无效');
  return id;
}
function sceneOf(store, sessionId) {
  try { return readSceneContext(store, sessionId); }
  catch { return null; }
}
function rootOf(store, sessionId) {
  return sceneRootSession(store, sessionId) || String(sessionId || '');
}

export function readSettingsMeta(store, sessionId) {
  const root = rootOf(store, sessionId);
  const row = store.db.prepare('SELECT * FROM task_settings_meta WHERE session_id=?').get(root);
  if (row) return {
    sessionId: root, rootSessionId: row.root_session_id || root,
    revision: Number(row.revision) || 0, roundSequence: Number(row.round_sequence) || 0,
    knowledgeRevision: Number(row.knowledge_revision) || 0,
    knowledgeEnabled: row.knowledge_enabled === 1,
    referenceStrategy: REFERENCE_STRATEGIES.includes(row.reference_strategy) ? row.reference_strategy : DEFAULT_REFERENCE_STRATEGY,
    schemaVersion: Number(row.schema_version) || SETTINGS_SCHEMA_VERSION,
    updatedAt: row.updated_at || '', virtual: false,
  };
  return {
    sessionId: root, rootSessionId: root, revision: 0, roundSequence: 0,
    knowledgeRevision: 0, knowledgeEnabled: false, referenceStrategy: DEFAULT_REFERENCE_STRATEGY,
    schemaVersion: SETTINGS_SCHEMA_VERSION, updatedAt: '', virtual: true,
  };
}
function ensureMeta(store, sessionId, initial = {}) {
  const current = readSettingsMeta(store, sessionId);
  if (!current.virtual) return current;
  const at = nowIso();
  const enabled = initial.knowledgeEnabled === true ? 1 : 0;
  const strategy = REFERENCE_STRATEGIES.includes(initial.referenceStrategy)
    ? initial.referenceStrategy : DEFAULT_REFERENCE_STRATEGY;
  store.db.prepare(`INSERT INTO task_settings_meta
    (session_id,root_session_id,revision,round_sequence,knowledge_revision,knowledge_enabled,reference_strategy,schema_version,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(current.sessionId, current.rootSessionId, current.revision, current.roundSequence,
      current.knowledgeRevision, enabled, strategy, SETTINGS_SCHEMA_VERSION, at);
  return readSettingsMeta(store, sessionId);
}
function writeKnowledgeMeta(store, sessionId, knowledge) {
  const current = ensureMeta(store, sessionId);
  const changed = current.knowledgeEnabled !== (knowledge.enabled === true)
    || current.referenceStrategy !== knowledge.strategy;
  if (!changed) return current;
  const enabled = knowledge.enabled === true ? 1 : 0;
  const strategy = REFERENCE_STRATEGIES.includes(knowledge.strategy)
    ? knowledge.strategy : current.referenceStrategy;
  store.db.prepare(`UPDATE task_settings_meta SET knowledge_revision=knowledge_revision+1,
    knowledge_enabled=?,reference_strategy=?,updated_at=? WHERE session_id=?`)
    .run(enabled, strategy, nowIso(), current.sessionId);
  return readSettingsMeta(store, sessionId);
}
function roundId(meta) { return meta.rootSessionId + ':' + meta.roundSequence; }

function taskMode(store, sessionId) {
  return store.db.prepare('SELECT mode FROM task_choice WHERE session_id=?').get(sessionId)?.mode || null;
}
function choiceRecord(store, sessionId) {
  return parseRecord(store.db.prepare('SELECT record FROM task_flow_choice WHERE session_id=?').get(sessionId), null);
}
function policyRecord(store, sessionId) {
  const row = store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get(sessionId);
  return row ? parseRowRecord(row, { table: 'task_policy', id: sessionId }) : null;
}
function competitionScene(store, sessionId, scene) {
  if (scene?.sceneId !== 'competition') return null;
  const root = scene.contextId || scene.rootSession || rootOf(store, sessionId);
  const row = store.db.prepare('SELECT record FROM scene_contexts WHERE session_id=?').get(root)
    || store.db.prepare('SELECT record FROM scene_contexts WHERE session_id=?').get(sessionId);
  const stored = parseRecord(row, null);
  return stored ? { root, stored, preferences: stored.preferences || {} } : { root, stored: {}, preferences: {} };
}

function limit(value, label) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const number = Number(value);
  const [min, max] = BUDGET_LIMITS[label];
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`${FIELD_LABELS['budget.' + label] || label}必须是 ${min}–${max} 的整数`);
  return number;
}
export function normalizeBudgetPatch(input) {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('budget 必须是对象');
  const unknown = Object.keys(input).filter(key => !(key in BUDGET_LIMITS));
  if (unknown.length) throw new Error('不支持的预算字段：' + unknown.join('、'));
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, limit(value, key)]));
}
function workerLimit(value, hostMax = 16) {
  const maximum = Number.isSafeInteger(hostMax) && hostMax >= 0 ? Math.min(16, hostMax) : 16;
  if (value === null || value === undefined || String(value).trim() === '')
    throw new Error(`助手上限必须是 0–${maximum} 的整数`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum)
    throw new Error(`助手上限必须是 0–${maximum} 的整数`);
  return number;
}
function modelConcurrency(value) {
  if (value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 16)
    throw new Error('本地模型并发必须是 1–16 的整数，或留空使用默认值');
  return number;
}
function normalizeKnowledge(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('knowledge 必须是对象');
  const unknown = Object.keys(input).filter(key => !['enabled', 'strategy'].includes(key));
  if (unknown.length) throw new Error('不支持的知识字段：' + unknown.join('、'));
  const out = {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new Error('knowledge.enabled 必须是布尔值');
    out.enabled = input.enabled;
  }
  if (input.strategy !== undefined) {
    if (!REFERENCE_STRATEGIES.includes(input.strategy))
      throw new Error('知识查询策略只能是 ' + REFERENCE_STRATEGIES.join('、'));
    out.strategy = input.strategy;
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeSettingsPatch(patch, sceneId) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new Error('patch 必须是对象');
  const allowed = new Set(sceneId === 'competition' ? COMPETITION_FIELDS : BASE_FIELDS.concat(SITE_FIELDS));
  const unknown = Object.keys(patch).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error('当前场景不支持设置字段：' + unknown.join('、'));
  const out = {};
  if (patch.interaction !== undefined) out.interaction = normalizeInteraction(patch.interaction);
  if (patch.reporting !== undefined) out.reporting = String(patch.reporting);
  if (patch.explain !== undefined) {
    if (typeof patch.explain !== 'boolean') throw new Error('解释原理必须是布尔值');
    out.explain = patch.explain;
  }
  if (patch.workers !== undefined) out.workers = patch.workers;
  if (patch.workerModel !== undefined) out.workerModel = normalizeModelChoice(patch.workerModel, '助手模型');
  if (patch.reviewModel !== undefined) out.reviewModel = normalizeModelChoice(patch.reviewModel, '复核模型');
  if (patch.reportModel !== undefined) out.reportModel = normalizeModelChoice(patch.reportModel, '报告模型');
  if (patch.modelConcurrency !== undefined) out.modelConcurrency = modelConcurrency(patch.modelConcurrency);
  if (patch.budget !== undefined) out.budget = normalizeBudgetPatch(patch.budget);
  if (patch.knowledge !== undefined) out.knowledge = normalizeKnowledge(patch.knowledge);
  if (sceneId !== 'competition') {
    if (patch.target !== undefined) {
      if (typeof patch.target !== 'string' || patch.target.length > 64000)
        throw new Error('测试范围必须是 64000 字以内的文本');
      out.target = patch.target;
    }
    if (patch.scope !== undefined) {
      if (!Array.isArray(patch.scope) && (!patch.scope || typeof patch.scope !== 'object'))
        throw new Error('scope 必须是数组或 {include,exclude} 对象');
      out.scope = patch.scope;
    }
    if (patch.allowedOrigins !== undefined) {
      if (!Array.isArray(patch.allowedOrigins) && typeof patch.allowedOrigins !== 'string')
        throw new Error('allowedOrigins 必须是数组或文本');
      out.allowedOrigins = patch.allowedOrigins;
    }
    if (patch.allowTargetNetwork !== undefined) {
      if (typeof patch.allowTargetNetwork !== 'boolean') throw new Error('允许访问网站必须是布尔值');
      out.allowTargetNetwork = patch.allowTargetNetwork;
    }
    if (patch.readOnly !== undefined) {
      if (typeof patch.readOnly !== 'boolean') throw new Error('仅发送 GET/HEAD 必须是布尔值');
      out.readOnly = patch.readOnly;
    }
    if (patch.excludedPaths !== undefined) {
      if (!Array.isArray(patch.excludedPaths) && typeof patch.excludedPaths !== 'string')
        throw new Error('排除路径必须是数组或文本');
      out.excludedPaths = patch.excludedPaths;
    }
    if (patch.requestRatePerMinute !== undefined)
      out.requestRatePerMinute = normalizeRequestRate(patch.requestRatePerMinute);
    if (patch.requestConcurrency !== undefined)
      out.requestConcurrency = normalizeRequestConcurrency(patch.requestConcurrency);
    if (patch.direction !== undefined) {
      if (!TASK_MODES.has(patch.direction)) throw new Error('测试重点无效');
      out.direction = patch.direction;
    }
  }
  return out;
}

function sceneIdOf(store, sessionId, scene, policy) {
  if (scene?.sceneId) return scene.sceneId;
  if (policy?.scenario === 'project') return 'cases';
  if (policy?.scenario) {
    try { return policy.scenario === 'project' ? 'cases' : 'free'; } catch { return 'free'; }
  }
  try {
    const inferred = readSceneContext(store, sessionId)?.sceneId;
    return inferred || 'free';
  } catch { return 'free'; }
}
function sceneRevisionOf(scene) {
  return Number.isSafeInteger(scene?.sceneRevision) ? scene.sceneRevision : 0;
}
function policyBudgetMinutes(policy) {
  if (Number.isInteger(policy?.budget?.minutes)) return policy.budget.minutes;
  if (Number.isInteger(policy?.budget?.deadline) && Number.isInteger(policy?.startedAt)
    && policy.budget.deadline > policy.startedAt)
    return Math.max(1, Math.ceil((policy.budget.deadline - policy.startedAt) / 60000));
  return policy?.budget?.deadline === null ? null : null;
}
function modelUsage(store, root, startedAt) {
  if (!Number.isInteger(startedAt)) return { used: 0, reserved: 0, tokens: 0, unknown: false };
  let rows = [];
  try {
    rows = store.db.prepare('SELECT state,record FROM task_model_calls WHERE root_session=? AND round_at=?')
      .all(root, startedAt).map(row => {
        try { return { state: row.state, ...JSON.parse(row.record) }; } catch { return { state: row.state }; }
      });
  } catch { return { used: 0, reserved: 0, tokens: 0, unknown: true }; }
  let used = 0, reserved = 0, tokens = 0, unknown = false;
  for (const row of rows) {
    if (row.state === 'cancelled') continue;
    used += 1;
    if (row.state === 'settled') tokens += Number(row.usage?.totalTokens) || 0;
    else {
      if (Number.isInteger(row.reservedTokens)) reserved += row.reservedTokens;
      else unknown = true;
      if (row.state === 'unknown') unknown = true;
    }
  }
  return { used, reserved, tokens, unknown };
}

function capabilitiesFor(sceneId, host = {}) {
  const editable = sceneId === 'competition'
    ? ['interaction', 'reporting', 'explain', 'workers', 'workerModel', 'reviewModel', 'reportModel',
      'budget.minutes', 'budget.toolCalls', 'budget.modelCalls', 'budget.tokens',
      'modelConcurrency', 'knowledge.enabled', 'knowledge.strategy']
    : ['interaction', 'reporting', 'explain', 'workers', 'workerModel', 'reviewModel', 'reportModel',
      'budget.minutes', 'budget.toolCalls', 'budget.modelCalls', 'budget.tokens',
      'budget.unmeteredToolCalls', 'modelConcurrency', 'target', 'scope', 'allowedOrigins',
      'allowTargetNetwork', 'readOnly', 'excludedPaths', 'requestRatePerMinute',
      'requestConcurrency', 'direction', 'knowledge.enabled', 'knowledge.strategy'];
  return {
    editable,
    supports: {
      modelConcurrency: true,
      modelCalls: host.modelAdmission !== false,
      tokens: host.tokens === true,
      workerModels: host.models !== false,
    },
    limits: {
      workers: Math.min(16, Number.isSafeInteger(host.maxWorkers) ? host.maxWorkers : 16),
      modelConcurrency: 16,
      ...Object.fromEntries(Object.entries(BUDGET_LIMITS).map(([key, [min, max]]) => [key, { min, max }])),
    },
    models: Array.isArray(host.models) ? host.models : [],
  };
}

export function settingsView(store, sessionId, options = {}) {
  const id = String(sessionId || '');
  if (!id) throw new Error('sessionId required');
  const warnings = [];
  const rootSession = rootOf(store, id);
  const meta = readSettingsMeta(store, id);
  const scene = sceneOf(store, id);
  let policy = null;
  try { policy = policyRecord(store, id); }
  catch { warnings.push('任务策略记录损坏；本次只显示可恢复的配置，不把空值当放宽后的授权。'); }
  const competition = competitionScene(store, id, scene);
  const choiceRow = competition ? null : store.db.prepare('SELECT record FROM task_flow_choice WHERE session_id=?').get(id);
  const choice = competition ? null : (parseRecord(choiceRow, null) || {});
  if (!competition && choiceRow && !parseRecord(choiceRow, null))
    warnings.push('任务草稿记录损坏；保留原记录供恢复，当前不自动放宽范围或额度。');
  const sceneId = options.sceneId || sceneIdOf(store, id, scene, policy);
  const started = !!policy && !policy.parentSession;
  let effective;
  if (competition) {
    const preferences = competition.preferences || {};
    const budget = preferences.budget || {};
    const minutes = budget.minutes ?? null;
    const start = Date.parse(budget.startedAt || '');
    const deadline = Number.isInteger(minutes) && Number.isFinite(start) ? start + minutes * 60000 : null;
    const roundAt = Date.parse(budget.roundStartedAt || competition.stored?.createdAt
      || preferences.updatedAt || competition.stored?.updatedAt || '');
    const ledger = Number.isFinite(roundAt) ? modelUsage(store, competition.root, roundAt)
      : { used: 0, reserved: 0, tokens: 0, unknown: false };
    effective = {
      target: '', scope: { include: [], exclude: [] }, allowedOrigins: [],
      allowTargetNetwork: false, readOnly: false, excludedPaths: [],
      requestRatePerMinute: null, requestConcurrency: null,
      interaction: preferences.interaction || 'auto', reporting: preferences.reporting || 'end',
      explain: preferences.explain === true, workers: Number(preferences.workers) || 0,
      workerModel: preferences.workerModel ?? null, reviewModel: preferences.reviewModel ?? null,
      reportModel: preferences.reportModel ?? null, modelConcurrency: preferences.modelConcurrency ?? null,
      budget: { minutes, toolCalls: budget.toolCalls ?? null, modelCalls: budget.modelCalls ?? null,
        tokens: budget.tokens ?? null, unmeteredToolCalls: null, deadline,
        used: { minutes: Number.isFinite(start)
          ? Math.max(0, Math.floor((taskElapsed({ startedAt: start, budget: { deadline } }).elapsedMs || 0) / 60000)) : 0,
          toolCalls: Number(budget.used?.toolCalls) || 0, modelCalls: ledger.used,
          tokens: ledger.tokens },
        reserved: { toolCalls: Number(budget.reserved?.toolCalls) || 0, modelCalls: 0,
          tokens: ledger.reserved }, usageUnknown: ledger.unknown },
    };
  } else if (started) {
    const usedModels = modelUsage(store, rootSession, policy.startedAt);
    const elapsed = taskElapsed(policy);
    effective = {
      target: policy.target || '', scope: policy.scope || { include: [], exclude: [] },
      allowedOrigins: policy.allowedOrigins || [], allowTargetNetwork: policy.allowTargetNetwork !== false,
      readOnly: policy.readOnly === true, excludedPaths: policy.excludedPaths || [],
      requestRatePerMinute: policy.requestRatePerMinute ?? null,
      requestConcurrency: policy.requestConcurrency ?? null,
      interaction: policy.interaction || 'auto', reporting: policy.reporting || 'end',
      explain: policy.explain === true, workers: Number(policy.workerLimit ?? policy.budget?.workers ?? 2),
      workerModel: policy.workerModel ?? null, reviewModel: policy.reviewModel ?? null,
      reportModel: policy.reportModel ?? null, modelConcurrency: policy.modelConcurrency ?? null,
      budget: { minutes: policyBudgetMinutes(policy), toolCalls: policy.budget?.toolCalls ?? null,
        modelCalls: policy.budget?.modelCalls ?? null, tokens: policy.budget?.tokens ?? null,
        unmeteredToolCalls: policy.budget?.unmeteredToolCalls ?? null,
        deadline: policy.budget?.deadline ?? null,
        used: { minutes: elapsed.elapsedMs === null ? 0 : Math.max(0, Math.floor(elapsed.elapsedMs / 60000)),
          toolCalls: Number(policy.used?.toolCalls) || 0, modelCalls: usedModels.used,
          tokens: usedModels.tokens,
          unmeteredToolCalls: Number(policy.used?.unmeteredToolCalls) || 0 },
        reserved: { toolCalls: 0, modelCalls: 0, tokens: usedModels.reserved },
        usageUnknown: usedModels.unknown },
    };
  } else {
    const budget = choice.budget || {};
    effective = {
      target: choice.target || '', scope: choice.scope || { include: [], exclude: [] },
      allowedOrigins: choice.allowedOrigins || [],
      allowTargetNetwork: choice.allowTargetNetwork !== false, readOnly: choice.readOnly === true,
      excludedPaths: choice.excludedPaths || [],
      requestRatePerMinute: choice.requestRatePerMinute ?? null,
      requestConcurrency: choice.requestConcurrency ?? null,
      interaction: choice.interaction || 'auto', reporting: choice.reporting || 'end',
      explain: choice.explain === true, workers: choiceRow ? (Number(choice.workers) || 0) : 2,
      workerModel: choice.workerModel ?? null, reviewModel: choice.reviewModel ?? null,
      reportModel: choice.reportModel ?? null, modelConcurrency: choice.modelConcurrency ?? null,
      budget: { minutes: budget.minutes ?? null, toolCalls: budget.toolCalls ?? null,
        modelCalls: budget.modelCalls ?? null, tokens: budget.tokens ?? null,
        unmeteredToolCalls: budget.unmeteredToolCalls ?? null, deadline: null,
        used: { minutes: 0, toolCalls: 0, modelCalls: 0, tokens: 0, unmeteredToolCalls: 0 },
        reserved: { toolCalls: 0, modelCalls: 0, tokens: 0 }, usageUnknown: false },
    };
  }
  let knowledge = {
    enabled: meta.knowledgeEnabled,
    strategy: meta.referenceStrategy,
    revision: meta.knowledgeRevision,
  };
  if ((meta.virtual || meta.knowledgeRevision === 0) && competition && competition.stored?.knowledgeEnabled === true) {
    knowledge = { enabled: true, strategy: 'knowledge-only', revision: 0, migratedLegacy: true };
    warnings.push('旧比赛资料开关仍按仅知识库查询；修改后会写入统一设置。');
  }
  effective.knowledge = knowledge;
  if (policy?.pendingChange?.fields?.length) {
    effective.pendingFields = [...new Set(policy.pendingChange.fields)];
    warnings.push('有已保存、等待当前操作结束后生效的变更。');
  }
  const phase = options.phase || (policy
    ? (policy.cancelled ? 'paused' : policy.turnEndedAt ? 'idle' : 'running')
    : 'preparing');
  return {
    sessionId: id,
    rootSessionId: rootSession,
    sceneId,
    roundId: roundId(meta),
    phase,
    settingsRevision: meta.revision,
    sceneRevision: sceneRevisionOf(scene),
    effective,
    capabilities: capabilitiesFor(sceneId, options.host || {}),
    warnings,
  };
}

export function settingsComparable(view) {
  return { effective: view?.effective || {}, sceneId: view?.sceneId || '' };
}

function normalizeScopePatch(current, patch) {
  if (patch.target === undefined && patch.scope === undefined && patch.allowedOrigins === undefined)
    return null;
  const normalized = normalizeTaskScope({
    target: patch.target !== undefined ? patch.target : current.target,
    scope: patch.scope !== undefined
      ? (patch.scope?.include ?? patch.scope)
      : patch.target !== undefined ? undefined : current.scope?.include,
    allowedOrigins: patch.allowedOrigins !== undefined
      ? patch.allowedOrigins
      : patch.target !== undefined ? undefined : current.allowedOrigins,
    excluded: patch.excludedPaths !== undefined ? patch.excludedPaths : current.excludedPaths,
    requestText: patch.target !== undefined ? patch.target : current.target,
  });
  if (!normalized.scope.include.length && patch.allowTargetNetwork !== false
    && current.allowTargetNetwork !== false)
    throw new Error('测试范围不能为空；只做离线分析时请同时关闭“允许访问网站”');
  return normalized;
}
function applySiteFields(next, current, patch) {
  const normalized = normalizeScopePatch(current, patch);
  if (normalized) {
    next.target = normalized.target;
    next.primaryTarget = normalized.primaryTarget;
    next.scope = normalized.scope;
    next.scopeTerms = normalized.terms;
    next.entrypoints = normalized.entrypoints;
    next.allowedOrigins = normalized.scope.include;
  }
  if (patch.excludedPaths !== undefined) next.excludedPaths = current.excludedPaths && patch.excludedPaths === current.excludedPaths
    ? current.excludedPaths : String(patch.excludedPaths).split(/[\r\n,]+/).map(value => value.trim()).filter(Boolean);
  if (patch.allowTargetNetwork !== undefined) next.allowTargetNetwork = patch.allowTargetNetwork;
  if (patch.readOnly !== undefined) next.readOnly = patch.readOnly;
  if (patch.requestRatePerMinute !== undefined) next.requestRatePerMinute = patch.requestRatePerMinute;
  if (patch.requestConcurrency !== undefined) next.requestConcurrency = patch.requestConcurrency;
  return next;
}
function applyBudget(next, current, patch, uptime, modelCounts) {
  const budget = { ...(next.budget || {}) };
  const used = current.used || current.budget?.used || {};
  const reserved = current.reserved || current.budget?.reserved || {};
  if (patch.minutes !== undefined) {
    if (patch.minutes === null) {
      budget.minutes = null;
      budget.deadline = null;
      delete budget.startedAt;
    } else {
      if (uptime.startedAt) {
        const deadline = uptime.startedAt + patch.minutes * 60000;
        if (deadline < uptime.now) throw new Error('时间上限早于当前时刻；请增大分钟数');
        budget.deadline = deadline;
      }
      budget.minutes = patch.minutes;
    }
  }
  if (patch.toolCalls !== undefined) {
    if (patch.toolCalls !== null && patch.toolCalls < (used.toolCalls || 0) + (reserved.toolCalls || 0))
      throw new Error(`工具调用上限不能低于已用与处理中数量（${(used.toolCalls || 0) + (reserved.toolCalls || 0)}）`);
    budget.toolCalls = patch.toolCalls;
  }
  if (patch.unmeteredToolCalls !== undefined) {
    if (patch.unmeteredToolCalls !== null && patch.unmeteredToolCalls < (used.unmeteredToolCalls || 0))
      throw new Error('未计量通道上限不能低于已使用数量');
    budget.unmeteredToolCalls = patch.unmeteredToolCalls;
    budget.unmeteredExplicit = true;
  }
  if (patch.modelCalls !== undefined) {
    if (patch.modelCalls !== null && patch.modelCalls < modelCounts.used + modelCounts.reserved)
      throw new Error(`模型调用上限不能低于已用与处理中数量（${modelCounts.used + modelCounts.reserved}）`);
    budget.modelCalls = patch.modelCalls;
  }
  if (patch.tokens !== undefined) {
    if (patch.tokens !== null && modelCounts.unknown)
      throw new Error('存在用量未知的模型请求，不能保存严格 token 上限');
    if (patch.tokens !== null && patch.tokens < modelCounts.tokens)
      throw new Error(`模型 token 上限不能低于已用与预留数量（${modelCounts.tokens}）`);
    budget.tokens = patch.tokens;
  }
  next.budget = budget;
  return next;
}
function applyCommon(next, patch) {
  if (patch.interaction !== undefined) {
    const interaction = normalizeInteraction(patch.interaction);
    next.interaction = interaction;
    if (patch.reporting === undefined) next.reporting = reportingFor({ interaction, reporting: next.reporting });
  }
  if (patch.reporting !== undefined) {
    next.reporting = reportingFor({ interaction: next.interaction || patch.interaction, reporting: patch.reporting });
  }
  if (patch.explain !== undefined) next.explain = patch.explain;
  if (patch.workers !== undefined) next.workers = patch.workers;
  for (const key of ['workerModel', 'reviewModel', 'reportModel']) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (patch.modelConcurrency !== undefined) next.modelConcurrency = patch.modelConcurrency;
  if (patch.direction !== undefined) {
    next.mode = patch.direction;
    next.flow = normalizeTaskFlow('single', patch.direction);
  }
  return next;
}
function applyDraft(store, sessionId, meta, patch, host) {
  const previous = choiceRecord(store, sessionId) || {};
  const current = settingsView(store, sessionId, { host }).effective;
  const mode = patch.direction || taskMode(store, sessionId) || previous.mode || 'regular';
  const next = {
    ...previous,
    workflow: 'single',
    scenario: previous.scenario || 'pentest',
    startMode: previous.startMode || 'direct-test',
    interaction: previous.interaction || current.interaction || 'auto',
    reporting: previous.reporting || current.reporting || 'end',
    explain: previous.explain === true || current.explain === true,
    workers: Number.isInteger(previous.workers) ? previous.workers : (Number(current.workers) || 0),
    target: previous.target || current.target || '',
    scope: previous.scope || current.scope,
    allowedOrigins: previous.allowedOrigins || current.allowedOrigins || [],
    allowTargetNetwork: previous.allowTargetNetwork === undefined ? current.allowTargetNetwork !== false : previous.allowTargetNetwork !== false,
    readOnly: previous.readOnly === true || current.readOnly === true,
    excludedPaths: previous.excludedPaths || current.excludedPaths || [],
    requestRatePerMinute: previous.requestRatePerMinute ?? current.requestRatePerMinute ?? null,
    requestConcurrency: previous.requestConcurrency ?? current.requestConcurrency ?? null,
    workerModel: previous.workerModel ?? current.workerModel ?? null,
    reviewModel: previous.reviewModel ?? current.reviewModel ?? null,
    reportModel: previous.reportModel ?? current.reportModel ?? null,
    modelConcurrency: previous.modelConcurrency ?? current.modelConcurrency ?? null,
    budget: { ...(previous.budget || {}) },
  };
  applyCommon(next, patch);
  if (patch.workers !== undefined) {
    next.workers = workerLimit(patch.workers, host.maxWorkers);
    next.workersExplicit = true;
  }
  if (patch.workers !== undefined) next.budget = { ...(next.budget || {}), workers: next.workers };
  applySiteFields(next, current, patch);
  if (patch.budget) {
    const budgetCurrent = { ...current, used: current.budget.used, reserved: current.budget.reserved };
    applyBudget(next, budgetCurrent, patch.budget, { startedAt: null, now: Date.now() },
      { used: 0, reserved: 0, tokens: 0, unknown: false });
  }
  store.db.prepare('INSERT INTO task_choice(session_id,mode) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode')
    .run(sessionId, mode);
  store.db.prepare('INSERT INTO task_flow_choice(session_id,record) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record')
    .run(sessionId, JSON.stringify(next));
  return { changed: true };
}
function policyComparable(policy) {
  if (!policy) return null;
  const keys = ['mode', 'interaction', 'reporting', 'explain', 'workerLimit', 'workerModel', 'reviewModel',
    'reportModel', 'allowTargetNetwork', 'readOnly', 'excludedPaths', 'requestRatePerMinute',
    'requestConcurrency', 'target', 'primaryTarget', 'scope', 'scopeTerms', 'entrypoints',
    'allowedOrigins', 'modelConcurrency', 'budget'];
  return Object.fromEntries(keys.map(key => [key, policy[key]]));
}
function applyStarted(store, sessionId, patch, host) {
  const policy = policyRecord(store, sessionId);
  if (!policy) throw new Error('task not started');
  const before = policyComparable(policy);
  const currentView = settingsView(store, sessionId, { host }).effective;
  const next = { ...policy, budget: { ...(policy.budget || {}) } };
  applyCommon(next, patch);
  if (patch.workers !== undefined) {
    next.workerLimit = workerLimit(patch.workers, host.maxWorkers);
    next.budget.workers = next.workerLimit;
  }
  applySiteFields(next, currentView, patch);
  if (patch.budget) {
    const usage = modelUsage(store, rootOf(store, sessionId), policy.startedAt);
    applyBudget(next, currentView, patch.budget,
      { startedAt: Number.isInteger(policy.startedAt) ? policy.startedAt : null, now: Date.now() },
      { used: usage.used, reserved: 0, tokens: usage.tokens + usage.reserved, unknown: usage.unknown });
  }
  if (policy.parentSession) throw new Error('子任务不能修改主任务设置');
  const changed = !same(before, policyComparable(next));
  if (changed) {
    writeTaskPolicy(store, sessionId, next, 'task-settings-updated',
      { source: 'desktop-user', skipSettingsRevision: true });
  }
  return { changed };
}
function applyCompetition(store, sessionId, meta, scene, patch, host) {
  const competition = competitionScene(store, sessionId, scene);
  if (!competition || scene?.sceneId !== 'competition') throw new Error('competition scene required');
  const preferences = competition.preferences || {};
  const before = stableJson(preferences);
  const view = settingsView(store, sessionId, { host }).effective;
  const next = { ...preferences };
  applyCommon(next, patch);
  if (patch.workers !== undefined) next.workers = workerLimit(patch.workers, host.maxWorkers);
  if (patch.budget) {
    next.budget = { ...(preferences.budget || {}) };
    const start = Date.parse(preferences.budget?.startedAt || '');
    const roundAt = Date.parse(preferences.budget?.roundStartedAt || competition.stored?.createdAt
      || preferences.updatedAt || competition.stored?.updatedAt || '');
    const ledger = Number.isFinite(roundAt) ? modelUsage(store, competition.root, roundAt)
      : { used: 0, reserved: 0, tokens: 0, unknown: false };
    applyBudget(next, view, patch.budget,
      { startedAt: Number.isFinite(start) ? start : null, now: Date.now() },
      { used: ledger.used, reserved: 0, tokens: ledger.tokens + ledger.reserved, unknown: ledger.unknown });
    if (patch.budget.minutes === null) {
      delete next.budget.startedAt;
      delete next.budget.roundStartedAt;
    }
  }
  if (patch.direction !== undefined) throw new Error('该设置不适用于比赛模式');
  const changed = stableJson(next) !== before;
  if (changed) {
    const record = {
      ...competition.stored,
      sceneId: 'competition',
      presetId: 'ctf-solver',
      contextId: competition.stored.contextId || competition.root,
      sceneRevision: sceneRevisionOf(scene),
      preferences: {
        ...next,
        revision: (Number(preferences.revision) || 0) + 1,
        updatedAt: nowIso(),
      },
      updatedAt: nowIso(),
    };
    store.db.prepare(`INSERT INTO scene_contexts(session_id,scene_id,preset_id,revision,record,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET scene_id=excluded.scene_id,preset_id=excluded.preset_id,
      revision=excluded.revision,record=excluded.record,updated_at=excluded.updated_at`)
      .run(competition.root, 'competition', 'ctf-solver', record.sceneRevision, JSON.stringify(record), record.updatedAt);
  }
  return { changed };
}
function assertCapabilities(patch, capabilities, sceneId) {
  if (patch.budget?.tokens !== undefined && patch.budget.tokens !== null && !capabilities.supports.tokens)
    throw new Error('当前宿主没有可靠的模型输入计数能力，不能保存严格 token 上限');
  if (patch.budget?.modelCalls !== undefined && patch.budget.modelCalls !== null && !capabilities.supports.modelCalls)
    throw new Error('当前宿主没有模型请求准入能力，不能保存模型调用上限');
  if (sceneId === 'competition' && patch.budget?.unmeteredToolCalls !== undefined)
    throw new Error('比赛模式不支持未计量通道上限');
}
function changeList(before, after) {
  const out = [];
  const visit = (a, b, prefix = '') => {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const key of keys) {
      if (key === 'knowledge' && prefix === '') continue;
      const av = a?.[key], bv = b?.[key];
      if ((av && typeof av === 'object' && !Array.isArray(av)) || (bv && typeof bv === 'object' && !Array.isArray(bv))) {
        visit(av || {}, bv || {}, prefix + key + '.');
      } else if (!same(av, bv)) out.push(prefix + key);
    }
  };
  visit(before.effective, after.effective);
  const bek = before.effective?.knowledge, aek = after.effective?.knowledge;
  if (bek?.enabled !== aek?.enabled) out.push('knowledge.enabled');
  if (bek?.strategy !== aek?.strategy) out.push('knowledge.strategy');
  return out;
}
function summaryOf(fields) {
  const labels = [...new Set(fields.map(field => {
    if (FIELD_LABELS[field]) return FIELD_LABELS[field];
    const leaf = field.split('.').pop();
    return FIELD_LABELS[leaf] || FIELD_LABELS[field.replace(/^effective\./, '')] || field;
  }))];
  return labels.length ? '设置已保存：' + labels.join('、') : '设置已保存';
}

export function saveTaskSettings(store, sessionId, input = {}, host = {}) {
  const id = String(sessionId || '');
  if (!id) throw new Error('sessionId required');
  const requestId = validRequestId(input.requestId);
  const root = rootOf(store, id);
  const scene = sceneOf(store, id);
  const policy = policyRecord(store, id);
  const sceneId = optionsScene(store, id, scene, policy, input.sceneId);
  const patch = normalizeSettingsPatch(input.patch, sceneId);
  const meta = readSettingsMeta(store, id);
  const expected = input.expected && typeof input.expected === 'object' ? input.expected : {};
  const payload = { sessionId: root, sceneId, expected, patch, host: {
    maxWorkers: host.maxWorkers, tokens: host.tokens === true, modelAdmission: host.modelAdmission !== false,
  } };
  const payloadDigest = digest(payload);
  return taskTransaction(store, () => {
    const old = store.db.prepare('SELECT payload_digest,result FROM task_settings_requests WHERE session_id=? AND request_id=?')
      .get(root, requestId);
    if (old) {
      if (old.payload_digest !== payloadDigest)
        throw Object.assign(new Error('同一 requestId 提交了不同内容；请为新修改生成新请求'), {
          code: 'settings-request-conflict',
        });
      return { ...JSON.parse(old.result), requestId, idempotent: true };
    }
    const before = settingsView(store, id, { host, sceneId });
    const capabilities = before.capabilities;
    assertCapabilities(patch, capabilities, sceneId);
    if (expected.settingsRevision !== undefined && Number(expected.settingsRevision) !== before.settingsRevision)
      throw Object.assign(new Error('设置已被另一窗口修改，请刷新后逐项重新选择'), {
        code: 'settings-conflict',
        details: { field: 'settingsRevision', expected: expected.settingsRevision,
          actual: before.settingsRevision, settingsView: before },
      });
    if (expected.roundId !== undefined && String(expected.roundId) !== before.roundId)
      throw Object.assign(new Error('任务轮次已变化；旧草稿不会写入新任务'), {
        code: 'settings-round-conflict',
        details: { expectedRoundId: expected.roundId, actualRoundId: before.roundId, settingsView: before },
      });
    if (expected.sceneRevision !== undefined && Number(expected.sceneRevision) !== before.sceneRevision)
      throw Object.assign(new Error('题目环境已变化，请刷新后再保存'), {
        code: 'settings-scene-conflict',
        details: { expectedSceneRevision: expected.sceneRevision, actualSceneRevision: before.sceneRevision,
          settingsView: before },
      });
    ensureMeta(store, id, before.effective.knowledge);
    let result;
    if (sceneId === 'competition') result = applyCompetition(store, id, meta, scene, patch, host);
    else if (policy) result = applyStarted(store, id, patch, host);
    else result = applyDraft(store, id, meta, patch, host);
    let knowledgeChanged = false;
    if (patch.knowledge) {
      const currentKnowledge = before.effective.knowledge;
      const nextKnowledge = { enabled: patch.knowledge.enabled ?? currentKnowledge.enabled,
        strategy: patch.knowledge.strategy ?? currentKnowledge.strategy };
      knowledgeChanged = nextKnowledge.enabled !== currentKnowledge.enabled
        || nextKnowledge.strategy !== currentKnowledge.strategy;
      if (knowledgeChanged) writeKnowledgeMeta(store, id, nextKnowledge);
    }
    let after = settingsView(store, id, { host, sceneId });
    const fields = changeList(before, after);
    const changed = fields.length > 0 || knowledgeChanged;
    if (changed) bumpSettingsRevision(store, id);
    after = settingsView(store, id, { host, sceneId });
    const response = {
      ok: true,
      noChange: !changed,
      requestId,
      settingsRevision: after.settingsRevision,
      appliedFields: changed ? fields : [],
      summary: changed ? summaryOf(fields.length ? fields : Object.keys(patch)) : '没有需要保存的改动',
      settingsView: after,
    };
    const at = Date.now();
    store.db.prepare('INSERT INTO task_settings_requests(session_id,request_id,payload_digest,result,created_at) VALUES(?,?,?,?,?)')
      .run(root, requestId, payloadDigest, JSON.stringify(response), at);
    store.db.prepare('DELETE FROM task_settings_requests WHERE session_id=? AND created_at<?')
      .run(root, at - 7 * 24 * 60 * 60 * 1000);
    store.db.prepare(`DELETE FROM task_settings_requests WHERE session_id=? AND request_id NOT IN
      (SELECT request_id FROM task_settings_requests WHERE session_id=? ORDER BY created_at DESC LIMIT 100)`)
      .run(root, root);
    return response;
  });
}
function optionsScene(store, sessionId, scene, policy, hint) {
  if (hint === 'competition' || scene?.sceneId === 'competition') return 'competition';
  if (hint === 'cases' || policy?.scenario === 'project') return 'cases';
  return 'free';
}

export function readSettingsRequest(store, sessionId, requestId) {
  const root = rootOf(store, sessionId);
  const row = store.db.prepare('SELECT result,created_at FROM task_settings_requests WHERE session_id=? AND request_id=?')
    .get(root, validRequestId(requestId));
  if (!row) return { ok: true, status: 'not-found', requestId, retryAllowed: true };
  return { ...JSON.parse(row.result), status: 'committed', idempotent: false };
}

export function currentSettingsExpected(store, sessionId, host = {}) {
  const view = settingsView(store, sessionId, { host });
  return { settingsRevision: view.settingsRevision, sceneRevision: view.sceneRevision, roundId: view.roundId };
}

export function legacySaveTaskSettings(store, sessionId, patch, host = {}, requestId = '') {
  return saveTaskSettings(store, sessionId, {
    requestId: requestId || `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    expected: currentSettingsExpected(store, sessionId, host),
    patch,
  }, host);
}

export function inheritedDraftBudget(store, sessionId) {
  const choice = choiceRecord(store, sessionId) || {};
  const budget = choice.budget || {};
  const value = {};
  for (const key of ['minutes', 'toolCalls', 'modelCalls', 'tokens', 'unmeteredToolCalls']) {
    if (Object.prototype.hasOwnProperty.call(budget, key)) value[key] = budget[key] ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(choice, 'modelConcurrency'))
    value.modelConcurrency = choice.modelConcurrency ?? null;
  return value;
}

export { rootOf as settingsRootSession };
