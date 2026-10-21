// 自动接续只认新增事实；随机回执 ID、时间与重复状态不能清零无进展次数。
// 摘要和已读范围保存在原 run 中，不增加模型登记工具或另一套调度器。
import { createHash } from 'node:crypto';
import { taskTransaction } from './task-policy-record.js';
import {
  readProjectRun, readProjectSource, listProjectChecks, listProjectActions, projectDocumentKey,
} from './project-store.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const writable = (run, controlRev) => run && ['preparing', 'running'].includes(run.state)
  && (controlRev === undefined || run.controlRev === controlRev);

function saveProgress(store, run, patch) {
  const next = { ...run, ...patch, updatedAt: new Date().toISOString() };
  store.db.prepare('UPDATE project_runs SET record=?,updated_at=? WHERE session_id=? AND run_id=?')
    .run(JSON.stringify(next), next.updatedAt, run.sessionId, run.runId);
  return next;
}

/** 合并实际发给模型的字符区间；重读、重叠片段和相同搜索结果不重复计进展。 */
export function recordProjectDocumentRead(store, sessionId, runId, input) {
  return taskTransaction(store, () => {
    const run = readProjectRun(store, sessionId, runId);
    if (!writable(run, input.controlRev)) return false;
    if (run.sourceSnapshot?.length && !run.sourceSnapshot.some(item =>
      item.sourceId === input.sourceId && item.sourceRevision === input.sourceRevision)) return false;
    const source = readProjectSource(store, sessionId, input.sourceId, input.sourceRevision);
    const section = source?.sections?.find(item => item.sectionId === input.sectionId);
    if (!section || !input.text) return false;
    const text = String(section.text || '');
    const start = Math.max(0, Math.trunc(Number(input.cursor) || 0));
    const end = start + input.text.length;
    if (text.slice(start, end) !== input.text) return false;
    const key = projectDocumentKey(input.sourceId, input.sourceRevision, input.sectionId);
    const coverage = { ...(run.progressDocumentCoverage || {}) };
    const previous = coverage[key] || [];
    const ranges = [...previous, [start, end]].sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    const length = intervals => intervals.reduce((sum, [from, to]) => sum + to - from, 0);
    if (length(merged) <= length(previous)) return false;
    coverage[key] = merged;
    saveProgress(store, run, {
      progressDocumentCoverage: coverage, progressRevision: (run.progressRevision || 0) + 1,
    });
    return true;
  });
}

function coverageFor(run, source, section) {
  const intervals = run.progressDocumentCoverage?.[projectDocumentKey(source.sourceId, source.sourceRevision, section.sectionId)] || [];
  const length = String(section.text || '').length;
  const covered = intervals.reduce((sum, [from, to]) => sum + Math.max(0, to - from), 0);
  return { covered, length, full: length === 0 || covered >= length };
}

/**
 * 当前 run 对固定来源快照的整理进度。读取不等于整理；只有本 run 的
 * requirements/reference/unreadable 决定才会消掉待处理区域。
 */
export function projectSourceProgress(store, sessionId, runId) {
  const run = readProjectRun(store, sessionId, runId);
  if (!run) return { total: 0, decided: 0, pending: 0, needsRead: 0, needsDecision: 0, unreadable: 0, items: [] };
  const decisions = run.sectionDecisions || {};
  const items = [];
  let total = 0, decided = 0, unreadable = 0;
  for (const snapshot of run.sourceSnapshot || []) {
    const source = readProjectSource(store, sessionId, snapshot.sourceId, snapshot.sourceRevision);
    if (!source) {
      items.push({
        sourceId: String(snapshot.sourceId || ''), sourceRevision: String(snapshot.sourceRevision || ''),
        sectionId: '#source', displayName: snapshot.displayName || snapshot.sourceId || '',
        state: 'missing', reason: '来源快照缺失',
      });
      total += 1;
      continue;
    }
    const sections = Array.isArray(source.sections) ? source.sections : [];
    const candidates = [...sections];
    if (!sections.length || (source.unread || []).length || source.parseState === 'unreadable' || source.parseState === 'partial')
      candidates.push({ sectionId: '#source', text: '' });
    for (const section of candidates) {
      total += 1;
      const key = projectDocumentKey(source.sourceId, source.sourceRevision, section.sectionId);
      const decision = decisions[key];
      if (decision) {
        decided += 1;
        if (decision.decision === 'unreadable') unreadable += 1;
        continue;
      }
      const coverage = coverageFor(run, source, section);
      const sourceLevel = section.sectionId === '#source';
      const sourceUnreadable = sourceLevel && (
        (source.unread || []).length > 0 || source.parseState === 'unreadable' || source.parseState === 'partial'
      );
      items.push({
        sourceId: source.sourceId, sourceRevision: source.sourceRevision,
        sectionId: section.sectionId, displayName: source.displayName || source.sourceId,
        location: section.location ?? null,
        state: sourceUnreadable ? 'unreadable' : coverage.full ? 'decision' : 'read',
        covered: coverage.covered, length: coverage.length,
      });
    }
  }
  const needsRead = items.filter(item => item.state === 'read' || item.state === 'missing').length;
  const needsDecision = items.filter(item => item.state === 'decision').length;
  const unreadablePending = items.filter(item => item.state === 'unreadable').length;
  return {
    total, decided, pending: items.length, needsRead, needsDecision,
    unreadable: unreadable + unreadablePending, items,
  };
}

/** 从现有真实回执和已保存结论补充事实，历史已见摘要保持不减，状态往返不算新信息。 */
export function projectProgressFingerprint(store, sessionId, runId) {
  return taskTransaction(store, () => {
    let run = readProjectRun(store, sessionId, runId);
    if (!run) return '';
    if (!writable(run)) return 'project-progress-v1:' + (run.progressRevision || 0);
    const seen = new Set(run.progressFacts || []);
    const before = seen.size;
    for (const check of listProjectChecks(store, sessionId, runId)) {
      if (check.executionState !== 'ended' || !check.verdict) continue;
      if (!check.checkedContent && !check.gaps && !check.findingRefs?.length) continue;
      seen.add(hash(['check', check.checkId, check.checkRevision, check.verdict,
        check.checkedContent, check.gaps, [...(check.findingRefs || [])].sort()]));
    }
    for (const action of listProjectActions(store, sessionId, runId)) {
      if (action.executionState === 'completed' && !action.sideEffectUnknown && action.pageRef && action.controlRev === run.controlRev) {
        const row = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(sessionId, action.pageRef);
        try {
          const observation = row && JSON.parse(row.record);
          if (observation?.source === 'host-project-browser-observation' && observation.projectRunId === runId
            && observation.actionId === action.actionId && observation.page && !observation.page.dialog)
            seen.add(hash(['browser-observation', action.checkId, action.identityRef, observation.page.url,
              observation.page.title, observation.page.text, observation.page.element]));
        } catch { /* Invalid observations provide no progress. */ }
      }
      if (action.executionState !== 'completed' || action.sideEffectUnknown || !action.requestRef
        || action.controlRev !== run.controlRev) continue;
      const row = store.db.prepare('SELECT record FROM execution_receipts WHERE session_id=? AND id=?')
        .get(sessionId, action.requestRef);
      let receipt;
      try { receipt = row && JSON.parse(row.record); } catch { continue; } // 坏回执不提供进展
      if (!receipt || receipt.projectRunId !== runId || receipt.projectCheckId !== action.checkId
        || receipt.actionId !== action.actionId || receipt.outcome !== 'response') continue;
      // 不包含 Date、Cookie、回执 ID 等不代表新业务观测的响应头。
      seen.add(hash(['response', action.checkId, receipt.method, receipt.url, receipt.authContext,
        receipt.requestSha256, receipt.status, receipt.responseBodyBase64, receipt.complete]));
    }
    if (seen.size > before) run = saveProgress(store, run, {
      progressFacts: [...seen], progressRevision: (run.progressRevision || 0) + seen.size - before,
    });
    return 'project-progress-v1:' + (run.progressRevision || 0);
  });
}
