// 工作台 UI 接线：概览摘要、依据复核入口、执行记录的“模型用量”切换。
// 这是源码接线检查，真实交互仍由官方 Desktop 验收。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'src', 'client', 'index.js'), 'utf8')
let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed += 1; console.log('FAIL ' + name + ': ' + error.message) }
}

await test('概览页使用 review.summary，且只在任务概览启用', () => {
  assert(source.includes('useWorkbenchQuery("review.summary", { rootId: rootId }'))
  assert(source.includes('page === "task" && taskTab === "overview" && !!rootId'))
  assert(source.includes('"data-saker-review-summary": "1"'))
  assert(source.includes('隔天复核摘要'))
  assert(source.includes('暂无已核对记录'))
})

await test('复核摘要条目使用动词入口打开已有详情或查询 command.status', () => {
  assert(source.includes('function openReviewItem(item)'))
  assert(source.includes('kind: "command.status"'))
  assert(source.includes('"查看操作记录"'))
  assert(source.includes('"查看回执"'))
  assert(source.includes('item.evidenceHint || "看依据"'))
  assert(source.includes('setDetailTab("evidence")'))
})

await test('发现详情接入 finding.evidence-review.save 和复核历史', () => {
  assert(source.includes('api("finding.evidence-review.save"'))
  assert(source.includes('expectedBasisDigest: data.basisDigest'))
  assert(source.includes('expectedHeadSeq: data.reviewHead ? Number(data.reviewHead.reviewSeq) || 0 : 0'))
  assert(source.includes('reviewRequest.current = requestId'))
  assert(source.includes('依据足以支持'))
  assert(source.includes('依据不足'))
  assert(source.includes('已更正先前判断'))
  assert(source.includes('data.reviewHistory'))
  assert(source.includes('原判断保留，当前依据不可复核'))
})

await test('执行记录默认保留原列表，并可切到 usage.round', () => {
  assert(source.includes('useStatе("records")') === false, 'do not use a Cyrillic-lookalike identifier')
  assert(source.includes('useState("records")'))
  assert(source.includes('useWorkbenchQuery("usage.round", { rootId: rootId }'))
  assert(source.includes('executionView === "usage"'))
  assert(source.includes('"模型用量"'))
  assert(source.includes('"执行记录"'))
  assert(source.includes('已知合计 tokens'))
  assert(source.includes('未观测发送'))
  assert(source.includes('发出前撤销'))
  assert(source.includes('不计预算只读'))
  assert(source.includes('现金费用：未知'))
  assert(source.includes('不计入本轮合计'))
})

await test('用量状态文案覆盖 reserved/dispatched/cancelled，未知不显示为 0', () => {
  assert(source.includes('reserved: "等待发送"'))
  assert(source.includes('dispatched: "传输中"'))
  assert(source.includes('cancelled: "未发送"'))
  assert(source.includes('row.usage ? String(row.usage.totalTokens) : "未知"'))
  assert(source.includes('value === null || value === undefined ? "未知"'))
})

await test('导出预览显示引用质量与人工复核计数，详情标签中文化', () => {
  assert(source.includes('引用质量'))
  assert(source.includes('人工复核'))
  assert(source.includes('wbEvidenceQualityLabel'))
  assert(source.includes('wbEvidenceRefKindLabel'))
  assert(source.includes('SEVERITY_LABEL[data.severity]'))
})

console.log(failed ? '\n' + failed + ' workbench review UI checks failed' : '\nworkbench review UI wiring passed')
process.exitCode = failed ? 1 : 0
