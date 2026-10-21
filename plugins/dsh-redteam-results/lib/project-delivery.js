// W06：项目结果导出。只读取已保存的检查、来源和引用，不访问目标；
// 表格内容按文本导出，不生成可执行公式。
import { zipDelivery, redactCredentials } from './bundle.js';
import { listProjectChecks, listProjectActions, readProjectRun, readProjectSource } from './project-store.js';
import { getFinding } from './store.js';
import { readExecutionReceipt } from './execution-receipts.js';
import { redactText, redactValue } from './redaction.js';

const RESULT_LABELS = {
  not_found: '未发现问题', issue: '发现问题', needs_check: '需进一步确认',
  blocked: '缺少条件', not_applicable: '不适用',
};
const RUN_LABELS = { preparing: '正在准备', running: '正在测试', waiting: '等待补充条件', paused: '已暂停', completed: '本次测试已结束', cancelled: '已停止', failed: '运行失败' };
const hasGaps = check => String(check.gaps || '').trim().length > 0;
const isPartial = check => check.executionState === 'ended' && check.verdict === 'not_found' && hasGaps(check);

// 页面与导出使用同一份展示事实，既保留已检查内容，也保留缺口。
export function projectCheckView(check) {
  let displayResult;
  if (check.executionState !== 'ended') displayResult = { running: '正在检查', paused: '已暂停' }[check.executionState] || '未开始';
  else displayResult = isPartial(check) ? '部分完成' : (RESULT_LABELS[check.verdict] || '未得出结论');
  const checked = String(check.checkedContent || '').trim();
  const gaps = String(check.gaps || '').trim();
  const displayNotes = [checked, gaps && (checked ? '还缺：' + gaps : gaps)].filter(Boolean).join('；');
  return { ...check, displayResult, displayNotes };
}
const tsvCell = value => {
  const text = String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  // Excel 会把 =/+/-/@ 开头的内容当公式；按文本导出时加前缀阻止执行。
  return /^[=+\-@]/.test(text) ? "'" + text : text;
};

export function projectCounts(checks) {
  const counts = { total: checks.length, ended: 0, checked: 0, issue: 0, needsCheck: 0, blocked: 0, notFound: 0, notApplicable: 0, pending: 0, notStarted: 0, inProgress: 0, paused: 0, partial: 0 };
  for (const check of checks) {
    if (check.executionState === 'ended') counts.ended++;
    else counts.pending++;
    if (check.executionState === 'pending') counts.notStarted++;
    if (check.executionState === 'running') counts.inProgress++;
    if (check.executionState === 'paused') counts.paused++;
    if (check.executionState !== 'ended') continue;
    if (check.verdict === 'issue') counts.issue++;
    else if (check.verdict === 'needs_check') counts.needsCheck++;
    else if (check.verdict === 'blocked') counts.blocked++;
    else if (check.verdict === 'not_found' && !isPartial(check)) counts.notFound++;
    else if (check.verdict === 'not_applicable') counts.notApplicable++;
    if (isPartial(check)) counts.partial++;
    if (check.verdict === 'issue' || (check.verdict === 'not_found' && !isPartial(check))) counts.checked++;
  }
  return counts;
}

export function buildProjectDeliveryFiles(store, sessionId, runId) {
  const run = readProjectRun(store, sessionId, runId);
  if (!run) throw new Error('project run not found');
  const checks = listProjectChecks(store, sessionId, runId);
  const actions = listProjectActions(store, sessionId, runId);
  const missing = [];
  const sources = (run.sourceSnapshot || []).map(snapshot => {
    const source = readProjectSource(store, sessionId, snapshot.sourceId, snapshot.sourceRevision);
    if (!source) missing.push({ kind: 'source', id: snapshot.sourceId, revision: snapshot.sourceRevision, reason: '运行快照中的来源缺失' });
    return source;
  }).filter(Boolean);
  const counts = projectCounts(checks);
  const rows = checks.map(projectCheckView).map(check => ({
    requirement: check.requirement,
    source: check.sourceLocation || '',
    result: check.displayResult,
    note: check.displayNotes,
    actionRefs: check.actionRefs || [],
    findingRefs: check.findingRefs || [],
  }));
  const evidenceFiles = {};
  for (const action of actions) {
    const evidence = { action: redactValue(action), receipt: null };
    if (action.requestRef) {
      try {
        const receipt = readExecutionReceipt(store, sessionId, action.requestRef);
        const body = Buffer.from(receipt.responseBodyBase64 || '', 'base64');
        evidence.receipt = redactValue({
          ...receipt,
          responseBodyBase64: undefined,
          responseBodyText: redactText(body.toString('utf8')).slice(0, 65536),
          capturedBytes: body.length,
        });
      } catch (error) {
        evidence.receiptMissing = redactText(error.message);
        missing.push({ kind: 'execution-receipt', id: action.requestRef, reason: error.message });
      }
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
    '# 按文档测试结果', '',
    '- 运行：' + run.runId,
    '- 状态：' + (RUN_LABELS[run.state] || '状态未知'),
    '- 检查项：' + counts.total + '；已检查 ' + counts.checked + '；发现问题 ' + counts.issue + '；需进一步确认 ' + counts.needsCheck + '；缺少条件 ' + counts.blocked + '；部分完成 ' + counts.partial + '；正在检查 ' + counts.inProgress + '；已暂停 ' + counts.paused + '；未开始 ' + counts.notStarted,
    '', '## 检查结果', '',
    ...rows.map(row => '- ' + row.requirement + '（来源：' + (row.source || '未记录') + '）→ ' + row.result + (row.note ? '：' + row.note : '') + (row.actionRefs.length ? ' [动作：' + row.actionRefs.join(', ') + ']' : '')),
    '', '## 说明', '',
    '本导出只整理已保存的检查结果和来源，不重新访问目标。缺少条件、需进一步确认和未开始的项没有写成通过。',
    '证据中的常见认证头与凭据字段已脱敏。',
  ].join('\n') + '\n';
  const tsv = ['文档要求\t来源\t结果\t说明', ...rows.map(row => [row.requirement, row.source, row.result, row.note].map(tsvCell).join('\t'))].join('\n') + '\n';
  const sourceList = sources.length
    ? sources.map(source => '- ' + (source.displayName || source.sourceId) + '（' + source.sourceRevision + '，' + source.parseState + '）').join('\n')
    : '没有已保存的来源。';
  const manifest = {
    runId: run.runId, state: run.state, sourceSnapshot: run.sourceSnapshot || [],
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
