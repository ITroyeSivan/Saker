// W06：项目结果导出。只读取已保存的检查、来源和引用，不访问目标；
// 表格内容按文本导出，不生成可执行公式。
import { zipDelivery, redactCredentials } from './bundle.js';
import { listProjectChecks, listProjectSources, readProjectRun } from './project-store.js';

const RESULT_LABELS = {
  not_found: '未发现问题', issue: '发现问题', needs_check: '需进一步确认',
  blocked: '缺少条件', not_applicable: '不适用',
};
const tsvCell = value => {
  const text = String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  // Excel 会把 =/+/-/@ 开头的内容当公式；按文本导出时加前缀阻止执行。
  return /^[=+\-@]/.test(text) ? "'" + text : text;
};

export function projectCounts(checks) {
  const counts = { total: checks.length, ended: 0, issue: 0, needsCheck: 0, blocked: 0, notFound: 0, notApplicable: 0, pending: 0, partial: 0 };
  for (const check of checks) {
    if (check.executionState === 'ended') counts.ended++;
    else counts.pending++;
    if (check.verdict === 'issue') counts.issue++;
    else if (check.verdict === 'needs_check') counts.needsCheck++;
    else if (check.verdict === 'blocked') counts.blocked++;
    else if (check.verdict === 'not_found') counts.notFound++;
    else if (check.verdict === 'not_applicable') counts.notApplicable++;
    if (check.verdict === 'not_found' && check.gaps) counts.partial++;
  }
  return counts;
}

export function buildProjectDeliveryFiles(store, sessionId, runId) {
  const run = readProjectRun(store, sessionId, runId);
  if (!run) throw new Error('project run not found');
  const checks = listProjectChecks(store, sessionId, runId);
  const sources = listProjectSources(store, sessionId);
  const counts = projectCounts(checks);
  const rows = checks.map(check => ({
    requirement: check.requirement,
    source: check.sourceLocation || '',
    result: check.executionState !== 'ended' ? (check.executionState === 'running' ? '正在检查' : '未开始') : (RESULT_LABELS[check.verdict] || '未得出结论'),
    note: check.checkedContent || check.gaps || '',
    actionRefs: check.actionRefs || [],
    findingRefs: check.findingRefs || [],
  }));
  const report = [
    '# 按文档测试结果', '',
    '- 运行：' + run.runId,
    '- 状态：' + run.state,
    '- 检查项：' + counts.total + '；已结束 ' + counts.ended + '；发现问题 ' + counts.issue + '；需进一步确认 ' + counts.needsCheck + '；缺少条件 ' + counts.blocked + '；部分完成 ' + counts.partial + '；未开始 ' + counts.pending,
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
  return {
    files: {
      'delivery/project-report.md': redactCredentials(report),
      'delivery/project-checks.tsv': redactCredentials(tsv),
      'delivery/project-sources.md': redactCredentials('# 测试文档来源\n\n' + sourceList + '\n'),
    },
    counts, run,
  };
}

export function zipProjectDelivery(store, sessionId, runId) {
  const bundle = buildProjectDeliveryFiles(store, sessionId, runId);
  return { ...bundle, archive: zipDelivery(bundle.files) };
}
