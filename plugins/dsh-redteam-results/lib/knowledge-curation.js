import { createHash } from 'node:crypto';
import { redactText } from './redaction.js';
import { sceneRootSession } from './scene-context.js';
import { findKnowledgeDuplicate, indexKnowledgeEntry } from './knowledge-index.js';

const ACTIVE = new Set(['queued', 'generating', 'editing']);
const TERMINAL = new Set(['saved', 'failed', 'cancelled', 'discarded']);
const controllers = new Map();
const now = () => Date.now();
const sha = value => createHash('sha256').update(String(value)).digest('hex');
function parse(row) {
  if (!row) return null;
  let model = {}, usage = {};
  try { model = JSON.parse(row.model_snapshot || '{}'); } catch { model = {}; }
  try { usage = JSON.parse(row.usage || '{}'); } catch { usage = { unknown: true }; }
  return { ...row, model, usage };
}
function view(row) {
  if (!row) return null;
  return {
    requestId: row.request_id, state: row.state, model: row.model,
    intentKey: row.intent_key || row.source_digest, retryOf: row.retry_of || '',
    editRevision: row.edit_revision, entryId: row.entry_id || null,
    usage: row.usage, wireAttempts: row.wire_attempts,
    error: row.error || '', createdAt: row.created_at, updatedAt: row.updated_at,
    selectedBytes: Buffer.byteLength(row.selected_text || '', 'utf8'),
    evidenceBytes: Buffer.byteLength(row.evidence_text || '', 'utf8'),
    draft: {
      title: row.draft_title || '', body: row.draft_body || '',
      conditions: row.draft_conditions || '', sources: row.draft_sources || '',
      product: row.draft_product || '', version: row.draft_version || '',
      applicability: row.draft_applicability || 'unknown',
    },
  };
}
function transaction(store, work) {
  const own = !store.db.isTransaction;
  if (own) store.db.exec('BEGIN IMMEDIATE');
  try { const result = work(); if (own) store.db.exec('COMMIT'); return result; }
  catch (error) { if (own) store.db.exec('ROLLBACK'); throw error; }
}
function readRow(store, requestId) {
  return parse(store.db.prepare('SELECT * FROM knowledge_curations WHERE request_id=?').get(String(requestId || '')));
}
function scopeKey(scope) {
  return typeof scope === 'string' ? scope : String(scope?.projectKey || scope?.rootSession || '');
}
function ownedRow(store, requestId, scope) {
  const row = readRow(store, requestId);
  if (!row) return null;
  const expectedRoot = typeof scope === 'string' ? '' : String(scope?.rootSession || '');
  const expected = scopeKey(scope);
  if (expectedRoot && row.root_session !== expectedRoot)
    throw new Error('整理请求不存在');
  if (!expectedRoot && expected && row.project_key !== expected && row.root_session !== expected)
    throw new Error('整理请求不存在');
  return row;
}

export function recoverKnowledgeCurations(store) {
  const at = now();
  const unsent = store.db.prepare(`UPDATE knowledge_curations SET state='failed',error=?,updated_at=?
    WHERE state='queued'`).run('中断前尚未发送；不会自动重发', at).changes;
  const unknown = store.db.prepare(`UPDATE knowledge_curations SET state='failed',error=?,usage=?,updated_at=?
    WHERE state='generating'`).run('生成中断，费用结果未知；不会自动重发', JSON.stringify({ unknown: true }), at).changes;
  return { unsent: Number(unsent) || 0, unknown: Number(unknown) || 0 };
}

export function startKnowledgeCuration(store, input, generate) {
  if (typeof generate !== 'function') throw new Error('独立生成适配器不可用');
  const requestId = String(input?.requestId || '').trim();
  if (!/^[A-Za-z0-9._:-]{4,160}$/.test(requestId)) throw new Error('整理 requestId 无效');
  const sessionId = String(input?.sessionId || '');
  if (!sessionId) throw new Error('sessionId required');
  const root = sceneRootSession(store, sessionId) || sessionId;
  const projectKey = String(input.projectKey || root);
  const selected = redactText(String(input.selectedText || ''));
  const evidence = redactText(String(input.evidenceText || ''));
  if (!selected.trim()) throw new Error('没有可整理的回答或发现正文');
  const selectedBytes = Buffer.byteLength(selected, 'utf8');
  const evidenceBytes = Buffer.byteLength(evidence, 'utf8');
  if (selectedBytes + evidenceBytes > 16384)
    throw new Error('所选正文与证据合计超过 16KiB，请缩小选择');
  if (evidenceBytes > 4096) throw new Error('关联证据超过 4KiB，请缩小选择');
  const model = input.model && typeof input.model === 'object'
    ? { provider: String(input.model.provider || ''), model: String(input.model.model || ''),
        ...(input.model.reasoningEffort ? { reasoningEffort: String(input.model.reasoningEffort) } : {}) }
    : null;
  if (!model?.provider || !model.model) throw new Error('点击时没有可用的 provider/model 快照');
  const sourceKey = String(input.sourceRef || ('latest-answer:' + sessionId)).slice(0, 500);
  const sourceDigest = sha([projectKey, sourceKey, selected, evidence].join('\0'));
  const existing = store.db.prepare(`SELECT * FROM knowledge_curations WHERE root_session=? AND source_digest=?
    AND state IN ('queued','generating','editing') ORDER BY updated_at DESC LIMIT 1`).get(root, sourceDigest);
  if (existing) return view(parse(existing));
  const prior = store.db.prepare(`SELECT request_id FROM knowledge_curations
    WHERE root_session=? AND source_digest=? AND state IN ('failed','cancelled')
    ORDER BY updated_at DESC LIMIT 1`).get(root, sourceDigest);
  const duplicateRequest = readRow(store, requestId);
  if (duplicateRequest) {
    if (duplicateRequest.root_session !== root || duplicateRequest.project_key !== projectKey)
      throw new Error('整理 requestId 已被其他会话使用');
    if (duplicateRequest.source_digest !== sourceDigest)
      throw new Error('同一整理 requestId 的内容不一致');
    return view(duplicateRequest);
  }
  transaction(store, () => {
    const at = now();
    store.db.prepare(`INSERT INTO knowledge_curations
      (request_id,root_session,project_key,source_key,source_digest,intent_key,retry_of,model_snapshot,state,edit_revision,
       selected_text,evidence_text,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(requestId, root, projectKey, sourceKey, sourceDigest, sourceDigest,
        prior?.request_id || '', JSON.stringify(model), 'queued', 0,
        selected, evidence, at, at);
  });
  setTimeout(() => { void runGeneration(store, requestId, generate); }, 0);
  return view(readRow(store, requestId));
}

export function createManualKnowledgeCuration(store, input = {}) {
  const requestId = String(input.requestId || '').trim();
  if (!/^[A-Za-z0-9._:-]{4,160}$/.test(requestId)) throw new Error('整理 requestId 无效');
  const sessionId = String(input.sessionId || '');
  if (!sessionId) throw new Error('sessionId required');
  const existing = readRow(store, requestId);
  const root = sceneRootSession(store, sessionId) || sessionId;
  const projectKey = String(input.projectKey || root);
  if (existing) {
    if (existing.root_session !== root || existing.project_key !== projectKey) throw new Error('整理 requestId 已被其他会话使用');
    return view(existing);
  }
  const selected = redactText(String(input.selectedText || '')).slice(0, 16384);
  if (!selected.trim()) throw new Error('没有可手动编辑的正文');
  const sourceKey = String(input.sourceRef || ('manual:' + sha(selected).slice(0, 24))).slice(0, 500);
  const sourceDigest = sha([projectKey, sourceKey, selected].join('\0'));
  const source = store.db.prepare(`SELECT * FROM knowledge_curations WHERE root_session=? AND source_digest=?
    AND state IN ('queued','generating','editing') ORDER BY updated_at DESC LIMIT 1`).get(root, sourceDigest);
  if (source) return view(parse(source));
  const at = now(), firstLine = selected.split(/\r?\n/).find(line => line.trim()) || '待整理经验';
  transaction(store, () => {
    store.db.prepare(`INSERT INTO knowledge_curations
      (request_id,root_session,project_key,source_key,source_digest,model_snapshot,state,edit_revision,
       selected_text,evidence_text,draft_title,draft_body,draft_sources,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(requestId, root, projectKey, sourceKey, sourceDigest, '{}', 'editing', 0,
        selected, '', firstLine.trim().slice(0, 240), selected, '', at, at);
  });
  return view(readRow(store, requestId));
}

function parseDraft(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('模型没有返回整理结果');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  const first = candidate.indexOf('{'), last = candidate.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('模型返回不是可编辑的知识 JSON');
  const value = JSON.parse(candidate.slice(first, last + 1));
  const draft = {
    title: String(value.title || '').trim().slice(0, 240),
    body: String(value.body || value.conclusion || '').trim(),
    conditions: String(value.conditions || value.applicability_conditions || '').trim(),
    sources: Array.isArray(value.sources) ? value.sources.map(item => String(item)).join('\n') : String(value.sources || '').trim(),
    product: String(value.product || '').trim().slice(0, 160),
    version: String(value.version || '').trim().slice(0, 160),
    applicability: ['exact', 'partial', 'unknown'].includes(value.applicability) ? value.applicability : 'unknown',
  };
  if (!draft.title || !draft.body) throw new Error('整理结果缺少标题或正文');
  return draft;
}
async function runGeneration(store, requestId, generate) {
  const row = readRow(store, requestId);
  if (!row || row.state !== 'queued') return;
  const changed = store.db.prepare("UPDATE knowledge_curations SET state='generating',updated_at=? WHERE request_id=? AND state='queued'")
    .run(now(), requestId).changes;
  if (!changed) return;
  const controller = new AbortController();
  controllers.set(requestId, controller);
  const timeout = setTimeout(() => controller.abort(Object.assign(new Error('整理生成超时'), { code: 'timeout' })), 120000);
  let wireAttempts = 0;
  try {
    const result = await generate({
      requestId, text: row.selected_text, evidence: row.evidence_text, model: row.model,
      signal: controller.signal,
      onWire() {
        wireAttempts += 1;
        try { store.db.prepare('UPDATE knowledge_curations SET wire_attempts=wire_attempts+1,updated_at=? WHERE request_id=?').run(now(), requestId); } catch { /* final write still records the count */ }
      },
    });
    const usage = result?.usage && typeof result.usage === 'object' ? result.usage : { unknown: true };
    const latest = readRow(store, requestId);
    if (!latest || latest.state === 'cancelled') {
      store.db.prepare('UPDATE knowledge_curations SET usage=?,wire_attempts=?,updated_at=? WHERE request_id=?')
        .run(JSON.stringify(usage), Math.max(wireAttempts, latest?.wire_attempts || 0), now(), requestId);
      return;
    }
    let draft;
    try { draft = parseDraft(result?.text); }
    catch (error) {
      store.db.prepare(`UPDATE knowledge_curations SET state='failed',draft_body=?,usage=?,wire_attempts=?,
        error=?,updated_at=? WHERE request_id=? AND state='generating' AND edit_revision=0`)
        .run(String(result?.text || '').slice(0, 16384), JSON.stringify(usage),
          Math.max(wireAttempts, latest.wire_attempts || 0), String(error.message || error), now(), requestId);
      return;
    }
    const next = store.db.prepare(`UPDATE knowledge_curations SET state='editing',draft_title=?,draft_body=?,
      draft_conditions=?,draft_sources=?,draft_product=?,draft_version=?,draft_applicability=?,
      usage=?,wire_attempts=?,error='',updated_at=?
      WHERE request_id=? AND state='generating' AND edit_revision=0`)
      .run(draft.title, draft.body, draft.conditions, draft.sources, draft.product, draft.version,
        draft.applicability, JSON.stringify(usage), Math.max(wireAttempts, latest.wire_attempts || 0), now(), requestId);
    if (!next.changes) {
      store.db.prepare('UPDATE knowledge_curations SET usage=?,wire_attempts=?,updated_at=? WHERE request_id=?')
        .run(JSON.stringify(usage), Math.max(wireAttempts, latest.wire_attempts || 0), now(), requestId);
    }
  } catch (error) {
    const latest = readRow(store, requestId);
    if (latest?.state !== 'cancelled') {
      store.db.prepare(`UPDATE knowledge_curations SET state='failed',usage=?,wire_attempts=?,error=?,updated_at=?
        WHERE request_id=? AND state='generating'`)
        .run(JSON.stringify({ unknown: wireAttempts > 0 }), Math.max(wireAttempts, latest?.wire_attempts || 0),
          redactText(error?.message || error || '整理失败'), now(), requestId);
    }
  } finally {
    clearTimeout(timeout);
    controllers.delete(requestId);
  }
}

export function getKnowledgeCuration(store, requestId, scope) {
  return view(ownedRow(store, requestId, scope));
}
export function updateKnowledgeCuration(store, requestId, patch = {}, options = {}) {
  const row = ownedRow(store, requestId, options);
  if (!row) throw new Error('整理请求不存在');
  if (options.expectedEditRevision !== undefined && Number(options.expectedEditRevision) !== Number(row.edit_revision))
    throw Object.assign(new Error('整理草稿已在其他窗口更新；请重新打开后再改'), { code: 'curation_conflict' });
  if (!['editing', 'failed', 'cancelled'].includes(row.state))
    throw new Error(row.state === 'generating' ? '生成中不能覆盖编辑稿' : '当前状态不能编辑');
  const text = key => patch[key] === undefined ? row['draft_' + key] : redactText(String(patch[key]));
  const applicability = patch.applicability === undefined ? row.draft_applicability
    : ['exact', 'partial', 'unknown'].includes(patch.applicability) ? patch.applicability : 'unknown';
  store.db.prepare(`UPDATE knowledge_curations SET state='editing',edit_revision=edit_revision+1,
    draft_title=?,draft_body=?,draft_conditions=?,draft_sources=?,draft_product=?,draft_version=?,
    draft_applicability=?,updated_at=? WHERE request_id=?`)
    .run(text('title').slice(0, 240), text('body'), text('conditions'), text('sources'),
      text('product').slice(0, 160), text('version').slice(0, 160), applicability, now(), requestId);
  return view(readRow(store, requestId));
}
export function cancelKnowledgeCuration(store, requestId, scope) {
  const row = ownedRow(store, requestId, scope);
  if (!row) throw new Error('整理请求不存在');
  if (TERMINAL.has(row.state)) return view(row);
  const controller = controllers.get(requestId);
  if (controller) controller.abort(Object.assign(new Error('用户取消整理'), { code: 'cancelled' }));
  store.db.prepare("UPDATE knowledge_curations SET state='cancelled',usage=?,error=?,updated_at=? WHERE request_id=?")
    .run(JSON.stringify(row.usage && !row.usage.unknown ? row.usage : { unknown: row.wire_attempts > 0 }),
      '用户取消；不会自动重试', now(), requestId);
  return view(readRow(store, requestId));
}
export function discardKnowledgeCuration(store, requestId, scope) {
  const row = ownedRow(store, requestId, scope);
  if (!row) throw new Error('整理请求不存在');
  if (row.state === 'saved') throw new Error('已保存的条目请从知识库编辑或停止检索');
  cancelKnowledgeCuration(store, requestId, scope);
  store.db.prepare(`UPDATE knowledge_curations SET state='discarded',selected_text='',evidence_text='',
    draft_title='',draft_body='',draft_conditions='',draft_sources='',draft_product='',draft_version='',
    updated_at=? WHERE request_id=?`).run(now(), requestId);
  return view(readRow(store, requestId));
}
export function saveKnowledgeCuration(store, requestId, input = {}, options = {}) {
  const row = ownedRow(store, requestId, options);
  if (!row) throw new Error('整理请求不存在');
  if (row.state !== 'editing') throw new Error('只有待检查的编辑稿可以保存');
  if (options.expectedEditRevision !== undefined && Number(options.expectedEditRevision) !== Number(row.edit_revision))
    throw Object.assign(new Error('整理草稿已在其他窗口更新；请重新打开后再保存'), { code: 'curation_conflict' });
  if (input.userConfirmed !== true) throw new Error('保存前请确认已检查内容');
  const title = redactText(String(input.title ?? row.draft_title)).trim();
  const body = redactText(String(input.body ?? row.draft_body)).trim();
  const sources = redactText(String(input.sources ?? row.draft_sources)).trim();
  if (!title || !body || !sources) throw new Error('标题、正文和来源引用不能为空');
  const product = redactText(String(input.product ?? row.draft_product)).trim();
  const version = redactText(String(input.version ?? row.draft_version)).trim();
  const applicability = ['exact', 'partial', 'unknown'].includes(input.applicability ?? row.draft_applicability)
    ? (input.applicability ?? row.draft_applicability) : 'unknown';
  const visibility = input.visibility === 'global' ? 'global' : 'project';
  const destinationProjectKey = String(options.projectKey || row.project_key);
  const duplicate = findKnowledgeDuplicate(destinationProjectKey, { title, text: body, product, version });
  if (duplicate?.kind === 'exact') {
    store.db.prepare("UPDATE knowledge_curations SET state='saved',entry_id=?,updated_at=? WHERE request_id=?")
      .run(duplicate.entry.sourceId, now(), requestId);
    return { ...view(readRow(store, requestId)), duplicate: 'exact', entry: duplicate.entry };
  }
  if (duplicate?.kind === 'similar' && input.asNew !== true)
    return { ...view(row), duplicate: 'similar', candidate: duplicate.entry, requiresChoice: true,
      message: '已有标题与产品相近的条目；请打开已有条目，或明确作为新条目保存。' };
  const sourceDigest = sha([destinationProjectKey, title, body, product, version].join('\0'));
  const entry = indexKnowledgeEntry({
    projectKey: destinationProjectKey,
    sourceId: 'curation-' + sourceDigest.slice(0, 24),
    sourceKind: 'curation', sourceLabel: '由回答整理',
    title, text: body, product, version, applicability,
    visibility,
    sourceDate: new Date().toISOString().slice(0, 10),
    status: 'ready',
    metadata: {
      conditions: redactText(String(input.conditions ?? row.draft_conditions)),
      sources, curationRequestId: requestId, model: row.model, visibility,
      verification: applicability === 'unknown' ? '待验证经验' : '用户已检查',
    },
  });
  store.db.prepare(`UPDATE knowledge_curations SET project_key=?,state='saved',entry_id=?,selected_text='',evidence_text='',
    draft_title=?,draft_body=?,draft_conditions=?,draft_sources=?,draft_product=?,draft_version=?,
    draft_applicability=?,updated_at=? WHERE request_id=?`)
    .run(destinationProjectKey, entry.sourceId, title, body, redactText(String(input.conditions ?? row.draft_conditions)),
      sources, product, version, applicability, now(), requestId);
  return { ...view(readRow(store, requestId)), duplicate: null, entry };
}

export function curationSystemPrompt() {
  return [
    '你是独立的一次性资料整理器，不执行工具，不续接主任务。',
    '只从用户给出的正文和证据中提炼可复用知识；不补造产品、版本、来源、日期或验证结论。',
    '返回一个 JSON 对象，字段：title（标题）、body（可复用做法或结论）、conditions（适用条件）、',
    'sources（原文中的来源引用，逐行）、product、version、applicability（exact/partial/unknown）。',
    '普通流水、重复失败、泛化口号和一次性的账号秘密不要保存。缺少事实时写“未知”或留空。',
  ].join('\n');
}
export function curationUserPrompt(text, evidence) {
  return '请整理以下内容。\n\n===== 选定正文 =====\n' + text
    + (evidence ? '\n\n===== 关联证据 =====\n' + evidence : '');
}
