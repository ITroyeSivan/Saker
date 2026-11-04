// W06：项目结果导出。只读取已保存的检查、来源和引用，不访问目标；
// 表格内容按文本导出，不生成可执行公式。
import { zipDelivery, redactCredentials } from './bundle.js';
import { listProjectChecks, listProjectActions, readProjectRun, readProjectSource } from './project-store.js';
import { getFinding } from './store.js';
import { readExecutionReceipt } from './execution-receipts.js';
import { responseBodyText } from './response-body.js';
import { createHash } from 'node:crypto';
import { redactText, redactValue } from './redaction.js';

const RESULT_LABELS = {
  expectation_met: '符合预期', not_found: '本次未发现问题（旧记录）', issue: '发现问题',
  needs_check: '待核对', blocked: '缺少条件', not_applicable: '不适用',
};
const RUN_LABELS = { preparing: '正在准备', running: '正在测试', waiting: '等待补充条件', paused: '已暂停', completed: '本次测试已结束', cancelled: '已停止', failed: '运行失败' };
const ACTIVE_RUN_STATES = new Set(['preparing', 'running']);
const NATIVE_FAILURE_GAP = '原生工具执行失败；程序已保存原始结果，需补齐条件后重试。';
const hasGaps = check => String(check.viewGaps ?? check.gaps ?? '').trim().length > 0;
const viewExecutionState = check => check.viewExecutionState || check.executionState;
const viewVerdict = check => check.viewVerdict || check.verdict;
const isPartial = check => viewExecutionState(check) === 'ended'
  && viewVerdict(check) === 'not_found' && hasGaps(check);

// 页面与导出使用同一份展示事实，既保留已检查内容，也保留缺口。
export function projectCheckView(check, context = {}) {
  const runState = String(context.runState || '');
  const actions = Array.isArray(context.actions) ? context.actions : [];
  const actionRefs = new Set(check.actionRefs || []);
  const relevantActions = actions.filter(action => actionRefs.has(action.actionId));
  const completedWithResult = relevantActions.some(action => action.executionState === 'completed'
    && !!(action.evidenceRef || action.requestRef || action.pageRef));
  const recoveredNativeFailure = check.executionState === 'ended'
    && check.verdict === 'blocked'
    && (String(check.gaps || '').trim() === NATIVE_FAILURE_GAP
      || String(check.gaps || '').trim().startsWith('原生工具执行失败；'))
    && completedWithResult;
  const interrupted = check.executionState === 'running'
    && !!runState && !ACTIVE_RUN_STATES.has(runState);
  const effectiveExecutionState = interrupted ? 'paused' : check.executionState;
  const effectiveVerdict = recoveredNativeFailure ? 'needs_check' : check.verdict;
  const effectiveGaps = recoveredNativeFailure ? '' : String(check.gaps || '');
  const ended = effectiveExecutionState === 'ended';
  const executionLabel = ended ? '已执行'
    : interrupted
      ? (runState === 'cancelled' ? '已停止' : '已中断')
      : ({ running: '正在执行', paused: '已暂停' }[effectiveExecutionState] || '未执行');
  let displayResult;
  if (!ended) displayResult = executionLabel;
  else displayResult = (effectiveExecutionState === 'ended' && effectiveVerdict === 'not_found'
    && effectiveGaps.trim()) ? '部分完成' : (RESULT_LABELS[effectiveVerdict] || '未得出结论');
  const checked = String(check.checkedContent || '').trim();
  const gaps = effectiveGaps.trim();
  const evidenceCount = new Set([
    ...(Array.isArray(check.evidenceRefs) ? check.evidenceRefs : []),
    ...(Array.isArray(check.actionRefs) ? check.actionRefs : []),
  ]).size;
  const confirmationLabel = !ended ? ''
    : effectiveVerdict === 'needs_check' ? '未独立核对'
      : effectiveVerdict === 'blocked' ? '条件不足'
        : effectiveVerdict === 'not_applicable' ? '不适用'
          : effectiveVerdict === 'not_found' && gaps ? '部分核对'
            : '有实际依据';
  const failedActionCount = relevantActions.filter(action => action.executionState === 'failed').length;
  const displayNotes = [checked, evidenceCount ? '实际依据 ' + evidenceCount + ' 项' : '',
    gaps && (checked ? '还缺：' + gaps : gaps),
    recoveredNativeFailure && failedActionCount
      ? '历史失败动作 ' + failedActionCount + ' 项已保留，后续已取得实际结果'
      : ''].filter(Boolean).join('；');
  return {
    ...check, displayResult, displayNotes, evidenceCount,
    executionLabel, conclusionText: checked || gaps || '', confirmationLabel,
    viewExecutionState: effectiveExecutionState, viewVerdict: effectiveVerdict, viewGaps: effectiveGaps,
  };
}
const tsvCell = value => {
  const text = String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  // Excel 会把 =/+/-/@ 开头的内容当公式；按文本导出时加前缀阻止执行。
  return /^[=+\-@]/.test(text) ? "'" + text : text;
};

export function projectCounts(checks) {
  const counts = { total: checks.length, ended: 0, executed: 0, checked: 0, unverified: 0, gaps: 0,
    expectationMet: 0, legacyNotFound: 0,
    issue: 0, needsCheck: 0, blocked: 0, notFound: 0, notApplicable: 0, pending: 0, notStarted: 0,
    inProgress: 0, paused: 0, interrupted: 0, partial: 0 };
  for (const check of checks) {
    const executionState = viewExecutionState(check);
    const verdict = viewVerdict(check);
    if (executionState === 'ended') {
      counts.ended++;
      counts.executed++;
    }
    else counts.pending++;
    if (executionState === 'pending') counts.notStarted++;
    if (executionState === 'running') counts.inProgress++;
    if (executionState === 'paused') counts.paused++;
    if (check.viewExecutionState && check.executionState !== check.viewExecutionState)
      counts.interrupted++;
    if (executionState !== 'ended') continue;
    if (verdict === 'expectation_met') counts.expectationMet++;
    else if (verdict === 'not_found') { counts.legacyNotFound++; if (!isPartial(check)) counts.notFound++; }
    else if (verdict === 'issue') counts.issue++;
    else if (verdict === 'needs_check') counts.needsCheck++;
    else if (verdict === 'blocked') counts.blocked++;
    else if (verdict === 'not_applicable') counts.notApplicable++;
    if (isPartial(check)) counts.partial++;
    if (verdict === 'needs_check') counts.unverified++;
    if (verdict === 'blocked' || isPartial(check)) counts.gaps++;
    if (verdict === 'expectation_met' || verdict === 'issue' || (verdict === 'not_found' && !isPartial(check))) counts.checked++;
  }
  return counts;
}

export function buildProjectDeliveryFiles(store, sessionId, runId) {
  const run = readProjectRun(store, sessionId, runId);
  if (!run) throw new Error('project run not found');
  const checks = listProjectChecks(store, sessionId, runId);
  const actions = listProjectActions(store, sessionId, runId);
  const views = checks.map(check => projectCheckView(check, { runState: run.state, actions }));
  const missing = [];
  const sources = (run.sourceSnapshot || []).map(snapshot => {
    const source = readProjectSource(store, sessionId, snapshot.sourceId, snapshot.sourceRevision);
    if (!source) missing.push({ kind: 'source', id: snapshot.sourceId, revision: snapshot.sourceRevision, reason: '运行快照中的来源缺失' });
    return source;
  }).filter(Boolean);
  const counts = projectCounts(views);
  const sourceDecisions = Object.values(run.sectionDecisions || {});
  const decisionCounts = sourceDecisions.reduce((out, decision) => {
    const key = String(decision?.decision || 'pending');
    out[key] = (out[key] || 0) + 1;
    return out;
  }, {});
  const rows = views.map(check => ({
    requirement: check.requirement,
    source: check.sourceLocation || '',
    result: check.displayResult,
    note: check.displayNotes,
    actionRefs: check.actionRefs || [],
    evidenceRefs: check.evidenceRefs || [],
    attemptId: check.activeAttempt?.attemptId || check.lastAttemptId || '',
    instanceRevision: check.instanceRevision || check.activeAttempt?.instanceRevision || 1,
    findingRefs: check.findingRefs || [],
    attemptHistory: (check.attempts || []).map(attempt => ({
      attemptId: attempt.attemptId,
      verdict: attempt.verdict,
      checkedContent: attempt.checkedContent,
      gaps: attempt.gaps,
      evidenceRefs: attempt.evidenceRefs || [],
      recordedAt: attempt.recordedAt,
    })),
  }));
  const evidenceFiles = {};
  const typedEvidence = [];
  for (const check of checks) {
    const historicalRefs = new Set((check.attempts || []).flatMap(attempt => attempt.evidenceRefs || []));
    const actionEvidenceRefs = actions
      .filter(action => action.checkId === check.checkId && action.evidenceRef)
      .map(action => action.evidenceRef);
    for (const evidenceRef of new Set([...(check.evidenceRefs || []), ...historicalRefs, ...actionEvidenceRefs])) {
      try {
        const row = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(sessionId, evidenceRef);
        if (!row) throw new Error('typed evidence material is missing');
        const material = JSON.parse(row.record);
        if (material.source !== 'host-project-evidence' || material.projectRunId !== runId
          || material.projectCheckId !== check.checkId) throw new Error('typed evidence ownership does not match the exported run/check');
        const attempts = new Set([check.activeAttempt?.attemptId, check.lastAttemptId,
          ...(check.attempts || []).map(attempt => attempt.attemptId)].filter(Boolean));
        const historical = historicalRefs.has(evidenceRef) && !new Set(check.evidenceRefs || []).has(evidenceRef);
        if (material.attemptId && attempts.size && !attempts.has(material.attemptId))
          throw new Error('typed evidence belongs to an attempt not referenced by this check');
        const safe = redactValue({ ...material, originalBase64: undefined });
        const file = 'delivery/evidence/typed/' + evidenceRef + '.json';
        evidenceFiles[file] = JSON.stringify(safe, null, 2) + '\n';
        typedEvidence.push({ id: evidenceRef, checkId: check.checkId, kind: material.kind,
          sourceType: material.sourceType, attemptId: material.attemptId,
          instanceRevision: material.instanceRevision, digest: material.digest, historical, file });
      } catch (error) {
        missing.push({ kind: 'typed-evidence', id: evidenceRef, checkId: check.checkId, reason: error.message });
      }
    }
  }
  for (const action of actions) {
    const evidence = { action: redactValue(action), receipt: null };
    if (action.pageRef) {
      try {
        const row = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(sessionId, action.pageRef);
        if (!row) throw new Error('浏览器观察正文缺失');
        const material = JSON.parse(row.record);
        if (material.source !== 'host-project-browser-observation' || material.projectRunId !== runId || material.actionId !== action.actionId)
          throw new Error('浏览器观察归属不一致');
        evidence.browserObservation = redactValue({ ...material, originalBase64: undefined });
        if (material.page?.screenshotBase64) {
          const file = 'delivery/evidence/screenshots/' + action.actionId + '.png';
          evidenceFiles[file] = Buffer.from(material.page.screenshotBase64, 'base64');
          evidence.browserObservation.page = { ...evidence.browserObservation.page, screenshotBase64: undefined, screenshotFile: file };
        }
      } catch (error) {
        missing.push({ kind: 'browser-observation', id: action.pageRef, reason: error.message });
      }
    }
    if (action.requestRef) {
      try {
        const receipt = readExecutionReceipt(store, sessionId, action.requestRef);
        const body = Buffer.from(receipt.responseBodyBase64 || '', 'base64');
        evidence.receipt = redactValue({
          ...receipt,
          responseBodyBase64: undefined,
          responseBodyText: redactText(responseBodyText(receipt).text),
          capturedBytes: body.length,
        });
      } catch (error) {
        evidence.receiptMissing = redactText(error.message);
        missing.push({ kind: 'execution-receipt', id: action.requestRef, reason: error.message });
      }
    }
    if (action.attachmentRef) {
      try {
        const row = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(sessionId, action.attachmentRef);
        if (!row) throw new Error('附件记录缺失');
        const material = JSON.parse(row.record);
        const bytes = Buffer.from(material.originalBase64 || '', 'base64');
        if (!material.originalBase64 || bytes.length !== material.bytes || createHash('sha256').update(bytes).digest('hex') !== material.digest)
          throw new Error('附件正文缺失或摘要、长度不一致');
        const name = String(material.displayName || 'download.bin').replace(/[^A-Za-z0-9._-]/g, '_').slice(-100);
        const file = 'delivery/evidence/attachments/' + action.actionId + '-' + name;
        evidenceFiles[file] = bytes;
        evidence.attachment = { id: action.attachmentRef, name: material.displayName, file, bytes: bytes.length, digest: material.digest };
      } catch (error) { missing.push({ kind: 'attachment', id: action.attachmentRef, reason: error.message }); }
    }
    evidenceFiles['delivery/evidence/actions/' + action.actionId + '.json'] = JSON.stringify(evidence, null, 2) + '\n';
  }
  const findingFiles = {};
  for (const findingId of [...new Set(checks.flatMap(check => check.findingRefs || []))]) {
    const finding = getFinding(store, sessionId, findingId);
    if (!finding) {
      missing.push({ kind: 'finding', id: findingId, reason: '检查引用的 finding 缺失' });
      continue;
    }
    findingFiles['delivery/evidence/findings/' + findingId + '.json'] = JSON.stringify(redactValue(finding), null, 2) + '\n';
  }
  const sourceFiles = {};
  for (const source of sources) {
    const name = String(source.sourceId + '-' + source.sourceRevision).replace(/[^A-Za-z0-9._-]/g, '_');
    sourceFiles['delivery/sources/' + name + '.md'] = redactCredentials([
      '# ' + (source.displayName || source.sourceId), '',
      '- sourceId：' + source.sourceId,
      '- sourceRevision：' + source.sourceRevision,
      '- parseState：' + source.parseState,
      '',
      ...(source.sections || []).map(section => '## ' + section.sectionId + (section.location ? ' ' + JSON.stringify(section.location) : '') + '\n\n' + String(section.text || '')),
      ...(source.unread || []).map(item => '## 未读区域\n\n' + JSON.stringify(item)),
    ].join('\n') + '\n');
  }
  const report = [
    '# 案例测试结果', '',
    '- 运行：' + run.runId,
    '- 状态：' + (RUN_LABELS[run.state] || '状态未知'),
    '- 检查项：' + counts.total + '；已检查 ' + counts.checked + '；发现问题 ' + counts.issue + '；需进一步确认 ' + counts.needsCheck + '；缺少条件 ' + counts.blocked + '；部分完成 ' + counts.partial + '；正在检查 ' + counts.inProgress + '；已暂停 ' + counts.paused + '；已中断 ' + counts.interrupted + '；未开始 ' + counts.notStarted,
    '', '## 检查结果', '',
    ...rows.map(row => '- ' + row.requirement + '（来源：' + (row.source || '未记录') + '）→ ' + row.result + (row.note ? '：' + row.note : '')
      + (row.actionRefs.length ? ' [动作：' + row.actionRefs.join(', ') + ']' : '')
      + (row.evidenceRefs.length ? ' [依据：' + row.evidenceRefs.join(', ') + '；attempt：' + row.attemptId
        + '；实例修订：' + row.instanceRevision + ']' : '')
      + (row.attemptHistory.length ? ' [历史尝试：' + row.attemptHistory.map(attempt =>
        attempt.attemptId + '/' + (attempt.verdict || '未完成') + '/' + (attempt.evidenceRefs.join(',') || '无依据')).join('；') + ']' : '')),
    '', '## 原表区域决定', '',
    ...(sourceDecisions.length ? sourceDecisions.map(decision =>
      '- ' + decision.sourceId + '@' + decision.sourceRevision + ' / ' + decision.sectionId
        + '：' + ({ requirements: '已执行要求', reference: '参考信息', excluded: '明确排除',
          'not-applicable': '不适用', pending: '待确认', unreadable: '无法解析' }[decision.decision] || decision.decision)
        + (decision.rationale ? '；' + decision.rationale : ''))
      : ['- 没有额外区域决定。']),
    '', '## 说明', '',
    '本导出只整理已保存的检查结果和来源，不重新访问目标。缺少条件、需进一步确认和未开始的项没有写成通过。',
    '证据中的常见认证头与凭据字段已脱敏。',
    '截图和下载保留原始内容，分享前请核对其中的业务数据。',
  ].join('\n') + '\n';
  const tsv = ['文档要求\t来源\t结果\t说明\t依据\tattempt\t实例修订',
    ...rows.map(row => [row.requirement, row.source, row.result, row.note, row.evidenceRefs.join(', '),
      row.attemptId, row.instanceRevision].map(tsvCell).join('\t'))].join('\n') + '\n';
  const sourceList = sources.length
    ? sources.map(source => '- ' + (source.displayName || source.sourceId) + '（' + source.sourceRevision + '，' + source.parseState + '）').join('\n')
    : '没有已保存的来源。';
  const manifest = {
    runId: run.runId, state: run.state, sourceSnapshot: run.sourceSnapshot || [],
    sourceDecisionCounts: decisionCounts, sourceDecisions,
    checks: checks.map(check => ({
      checkId: check.checkId, attemptId: check.activeAttempt?.attemptId || check.lastAttemptId || '',
      instanceRevision: check.instanceRevision || check.activeAttempt?.instanceRevision || 1,
      evidenceRefs: check.evidenceRefs || [],
      attemptHistory: (check.attempts || []).map(attempt => ({
        attemptId: attempt.attemptId, verdict: attempt.verdict, evidenceRefs: attempt.evidenceRefs || [],
      })),
    })),
    typedEvidence,
    files: ['delivery/project-report.md', 'delivery/project-checks.tsv', 'delivery/project-sources.md',
      ...Object.keys(evidenceFiles), ...Object.keys(findingFiles), ...Object.keys(sourceFiles),
      ...(missing.length ? ['delivery/missing.md'] : [])],
    missing,
  };
  return {
    files: {
      'delivery/project-report.md': redactCredentials(report),
      'delivery/project-checks.tsv': redactCredentials(tsv),
      'delivery/project-sources.md': redactCredentials('# 测试文档来源\n\n' + sourceList + '\n'),
      ...sourceFiles,
      ...evidenceFiles,
      ...findingFiles,
      'delivery/manifest.json': JSON.stringify(manifest, null, 2) + '\n',
      ...(missing.length ? { 'delivery/missing.md': '# 缺失材料\n\n' + missing.map(item => '- ' + item.kind + ' ' + item.id + '：' + redactText(item.reason)).join('\n') + '\n' } : {}),
    },
    counts, run, missing,
  };
}

export function zipProjectDelivery(store, sessionId, runId) {
  const bundle = buildProjectDeliveryFiles(store, sessionId, runId);
  return { ...bundle, archive: zipDelivery(bundle.files) };
}
