import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, readTaskPolicy, taskExecutionGuard, taskPrompt, taskPromptStable } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { moduleInitialization } from '../plugins/dsh-method-stack/lib/selection-config.js';
import { taskModuleSelection, saveTaskModules } from '../plugins/dsh-redteam-results/lib/task-modules.js';
import { checkRegistered } from '../plugins/dsh-scanner-tools/lib/index.js';
import { matchesScope, scopeSafeAsset } from '../lib/asset-inventory.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-auto-recon-'));
process.env.DSH_HOME = home;
const workspace = path.join(home, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const store = openStore(path.join(home, 'redteam-results/results.db'));
const ALL = moduleInitialization(home, 'fixture', 'regular').keys;
const setModules = (sid, active) => {
  const config = moduleInitialization(home, sid, 'regular');
  const current = taskModuleSelection(store, sid, config);
  return saveTaskModules(store, sid, { mode: current.mode, active, rev: current.rev, policyRev: current.policyRev }, config);
};
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message); } };
try {
  test('both starting points are recorded, the prompt names the one in force, and auto-recon carries a bounded scan allowance', () => {
    startTaskPolicy(store, 'materials', { mode: 'regular', startMode: 'materials-first', question: '先用已有材料', budget: { toolCalls: 10 } });
    startTaskPolicy(store, 'scope-only', { mode: 'regular', startMode: 'auto-recon', question: '只给范围，补必要入口', target: 'http://127.0.0.1:9', budget: { toolCalls: 10 } });
    assert.equal(readTaskPolicy(store, 'materials').startMode, 'materials-first');
    assert.equal(readTaskPolicy(store, 'scope-only').startMode, 'auto-recon');
    const autoPrompt = taskPrompt({ configured: true, policy: readTaskPolicy(store, 'scope-only'), stopped: false });
    assert(autoPrompt.includes('起步方式=自动信息收集'));
    assert(autoPrompt.includes('先按缺项采集并落盘入口'), 'auto-recon must state the collect-then-check chain');
    assert(taskPrompt({ configured: true, policy: readTaskPolicy(store, 'materials'), stopped: false }).includes('起步方式=资料优先'));
    // 选了"自动信息收集"就是明确要采集：给**有界默认额度**，而不是默认拒绝。
    assert.equal(readTaskPolicy(store, 'scope-only').budget.unmeteredToolCalls, 3, 'auto-recon suggests a bounded scan allowance');
    assert.equal(readTaskPolicy(store, 'materials').budget.unmeteredToolCalls, 0, 'other starting points still default to zero');
    // 用户显式改 0 仍然优先。
    startTaskPolicy(store, 'auto-zero', { mode: 'regular', startMode: 'auto-recon', budget: { toolCalls: 10, unmeteredToolCalls: 0 } });
    assert.equal(readTaskPolicy(store, 'auto-zero').budget.unmeteredToolCalls, 0, 'an explicit zero overrides the suggestion');
  });
  test('a scan tool with unmeasurable target traffic is refused until the task allows it explicitly', () => {
    const before = readTaskPolicy(store, 'materials');
    const denial = taskExecutionGuard(store, 'materials', 'httpx_probe');
    assert.match(denial, /unmetered_target_traffic/);
    assert.match(denial, /unmeteredToolCalls=N/, 'the refusal must name the concrete fix');
    const after = readTaskPolicy(store, 'materials');
    assert.equal(after.used.toolCalls, before.used.toolCalls, 'a refused scan must not consume the tool budget');
    assert.equal(after.used.unmeteredToolCalls, 0);
    assert.equal(taskExecutionGuard(store, 'materials', 'read'), undefined, 'a metered local read is unaffected');
  });
  test('an explicit allowance admits exactly that many unmetered calls and then stops', () => {
    startTaskPolicy(store, 'allowed', { mode: 'regular', startMode: 'auto-recon', budget: { toolCalls: 10, unmeteredToolCalls: 1 } });
    assert.equal(taskExecutionGuard(store, 'allowed', 'ffuf_fuzz'), undefined);
    assert.equal(readTaskPolicy(store, 'allowed').used.unmeteredToolCalls, 1);
    assert.equal(readTaskPolicy(store, 'allowed').used.toolCalls, 1, 'a scan is still one tool call');
    const denied = taskExecutionGuard(store, 'allowed', 'nuclei_scan');
    assert.match(denied, /unmetered_traffic_budget_exhausted/);
    assert.equal(readTaskPolicy(store, 'allowed').used.unmeteredToolCalls, 1, 'the exhausted allowance must not grow');
    assert.equal(readTaskPolicy(store, 'allowed').used.toolCalls, 1);
    assert(taskPrompt({ configured: true, policy: readTaskPolicy(store, 'allowed'), stopped: false }).includes('未计量目标流量=1/1'));
    // 实测发现：模型会用宿主 shell 直接发目标请求，绕过执行回执链——提示词必须点明这点。
    assert(taskPrompt({ configured: true, policy: readTaskPolicy(store, 'allowed'), stopped: false }).includes('不会产生宿主执行回执'));
    // 实测 J2–J9：模型宁可翻文件找契约也不猜——工具契约最短路径要写进每轮提示词。
    const hint = taskPrompt({ configured: true, policy: readTaskPolicy(store, 'allowed'), stopped: false });
    for (const removed of ['first-contact', 'run-pair', 'responseReceiptId', 'normalRequests', 'verify-effect', '整包替换']) {
      assert(!hint.includes(removed), '默认任务快照不得重新塞回操作教程：' + removed);
    }
    assert(hint.includes('redteam_task progress {planComplete:true}') && hint.includes('只等待用户资料或未完成时不要标记'),
      '回合结束前的显式收口与不标记边界仍要保留');
    // 受控工具面只暴露 exercise_request/exercise_submit：常驻提示必须跟着实际工具面走。
    const controlled = taskPromptStable({ configured: true, policy: readTaskPolicy(store, 'allowed'), stopped: false }, { controlledInterface: true });
    assert(controlled.includes('exercise_request') && controlled.includes('exercise_submit'), '受控工具面要说明实际可用工具');
    for (const forbidden of ['redteam_context', 'first-contact', 'run-pair', 'verify-effect']) {
      assert(!controlled.includes(forbidden), '受控工具面不得引用被隐藏的工具：' + forbidden);
    }
    assert(taskPromptStable({ configured: true, policy: readTaskPolicy(store, 'allowed'), stopped: false }).includes('redteam_task'),
      '普通工具面仍保留任务收口入口');
    // E09 实测：模型结束回合后任务等到时限——结束前的显式收口必须写进每轮提示词。
    assert(hint.includes('redteam_task progress {planComplete:true}') && hint.includes('只等待用户资料或未完成时不要标记'),
      '回合结束前的显式收口与不标记边界要写进每轮提示词');
  });
  test('shell and unknown network capabilities require quota while explicit offline MCP tools stay local', () => {
    startTaskPolicy(store, 'shell-gate', { mode: 'regular', question: '只查这个入口', target: 'http://127.0.0.1:3000', budget: { toolCalls: 10, unmeteredToolCalls: 0 } });
    assert.match(taskExecutionGuard(store, 'shell-gate', 'pwsh', Date.now(), { args: { command: 'Get-ChildItem . | Select-Object -First 3' } }), /unmetered_target_traffic/, '不凭命令文本推断任意脚本没有网络能力');
    assert.equal(readTaskPolicy(store, 'shell-gate').used.toolCalls, 0, '拒绝的未知能力不计已执行');
    const denied = taskExecutionGuard(store, 'shell-gate', 'pwsh', Date.now(), { args: { command: 'Invoke-WebRequest http://127.0.0.1:3000/rest/products/search?q=apple' } });
    assert.match(String(denied), /unmetered_target_traffic/, '命令里带授权范围内 URL 时按未计量目标流量处理');
    assert.equal(readTaskPolicy(store, 'shell-gate').used.toolCalls, 0, '被拒的 shell 调用不占预算');
    assert.match(taskExecutionGuard(store, 'shell-gate', 'pwsh', Date.now(), { args: { command: 'curl https://outside.example.org/' } }), /unmetered_target_traffic/, '未匹配当前范围不等于没有网络能力');
    startTaskPolicy(store, 'shell-gate-ok', { mode: 'regular', question: '只查这个入口', target: 'http://127.0.0.1:3000', budget: { toolCalls: 10, unmeteredToolCalls: 1 } });
    assert.equal(taskExecutionGuard(store, 'shell-gate-ok', 'pwsh', Date.now(), { args: { command: 'curl http://127.0.0.1:3000/rest/products/search?q=apple' } }), undefined);
    assert.equal(readTaskPolicy(store, 'shell-gate-ok').used.unmeteredToolCalls, 1, 'shell 目标流量计入未计量额度');
    // 2026-10-18 完整任务实测：MCP 通道原先既不占未计量额度也不受范围/停止约束
    // （模型用 Yakit batch_do_http_request 向目标发了 68 次请求，只留下 3 条回执）。
    const mcpArgs = { server: 'yakit', tool: 'batch_do_http_request', args: { 'base-url': 'http://127.0.0.1:3000', method: 'GET', paths: '/a\n/b' } };
    assert.match(String(taskExecutionGuard(store, 'shell-gate', 'mcp_call', Date.now(), { args: mcpArgs })), /unmetered_target_traffic/,
      'MCP 批量请求带授权范围 URL 时同样按未计量目标流量处理');
    const splitHostArgs = { server: 'yakit', tool: 'do_http_request', args: { host: '127.0.0.1', port: 3000, path: '/a', isHttps: false } };
    assert.match(String(taskExecutionGuard(store, 'shell-gate', 'mcp_call', Date.now(), { args: splitHostArgs })), /unmetered_target_traffic/,
      'MCP 的 host/port/path 分离参数也必须按目标流量处理');
    const rawHttpArgs = { server: 'yakit', tool: 'do_http_request', args: { request: 'GET /a HTTP/1.1\r\nHost: 127.0.0.1:3000\r\n\r\n' } };
    assert.match(String(taskExecutionGuard(store, 'shell-gate', 'mcp_call', Date.now(), { args: rawHttpArgs })), /unmetered_target_traffic/,
      '原始 HTTP 报文也必须按目标流量处理');
    assert.equal(taskExecutionGuard(store, 'shell-gate', 'mcp_call', Date.now(), { args: { server: 'burp', tool: 'base64_encode', args: { content: 'saker' } } }), undefined,
      '不含目标 URL 的 MCP 调用不受这条闸门影响');
    // shell 已经用掉唯一一次额度：同一任务的 MCP 目标流量必须被拒（不能因为换了通道就免费）
    assert.match(String(taskExecutionGuard(store, 'shell-gate-ok', 'mcp_call', Date.now(), { args: mcpArgs })), /unmetered_traffic_budget_exhausted/,
      '同一额度跨通道共用，换 MCP 不能绕过');
    assert.equal(readTaskPolicy(store, 'shell-gate-ok').used.unmeteredToolCalls, 1, '被拒的 MCP 调用不占额度');
    startTaskPolicy(store, 'mcp-gate-ok', { mode: 'regular', question: '只查这个入口', target: 'http://127.0.0.1:3000', budget: { toolCalls: 10, unmeteredToolCalls: 1 } });
    assert.equal(taskExecutionGuard(store, 'mcp-gate-ok', 'mcp_call', Date.now(), { args: mcpArgs }), undefined);
    assert.equal(readTaskPolicy(store, 'mcp-gate-ok').used.unmeteredToolCalls, 1, 'MCP 目标流量也计入未计量额度');
    // 一次调用 = 一个可审计请求的受控入口（本地效果基准的 exercise_request）不能被当成未计量扫描器，
    // 否则基准的引用契约整体判死：2026-10-18 实测 h1 的 7 次 exercise_request 全被拒、requests=0。
    startTaskPolicy(store, 'metered-gate', { mode: 'regular', question: '受控接口', target: 'http://127.0.0.1:3000', budget: { toolCalls: 10, unmeteredToolCalls: 0 } });
    assert.equal(taskExecutionGuard(store, 'metered-gate', 'exercise_request', Date.now(),
      { args: { url: 'http://127.0.0.1:3000/document?id=1', method: 'GET' } }), undefined,
      '逐条可审计的受控入口不按未计量处理');
  });
  test('本地/规划类工具如实计数但不占目标预算（否则界面会显示 0 而实际用了很多次）', () => {
    startTaskPolicy(store, 'local-count', { mode: 'regular', budget: { toolCalls: 5 } });
    assert.equal(taskExecutionGuard(store, 'local-count', 'redteam_context'), undefined);
    assert.equal(taskExecutionGuard(store, 'local-count', 'read'), undefined);
    assert.equal(taskExecutionGuard(store, 'local-count', 'redteam_research'), undefined);
    const policy = readTaskPolicy(store, 'local-count');
    assert.equal(policy.used.toolCalls, 0, '本地工具不占目标预算');
    assert.equal(policy.used.localToolCalls, 3, '但必须如实计数');
  });
  test('closing a collection module blocks that collection tool while existing material stays readable', () => {
    startTaskPolicy(store, 'closed-collection', { mode: 'regular', startMode: 'auto-recon', budget: { toolCalls: 10, unmeteredToolCalls: 5 } });
    setModules('closed-collection', ALL.filter(key => key !== 'fingerprint'));
    const denial = taskExecutionGuard(store, 'closed-collection', 'httpx_probe');
    assert.match(denial, /collection_module_disabled/);
    assert.match(denial, /fingerprint/);
    assert.equal(readTaskPolicy(store, 'closed-collection').used.unmeteredToolCalls, 0, 'a blocked collection action must not spend the allowance');
    assert.equal(taskExecutionGuard(store, 'closed-collection', 'read'), undefined, 'reading existing material is still allowed');
    assert.equal(taskExecutionGuard(store, 'closed-collection', 'redteam_context'), undefined);
    assert.equal(taskExecutionGuard(store, 'closed-collection', 'ffuf_fuzz'), undefined, 'a different module keeps working');
  });
  test('active scans refuse a target that is not registered in the workspace baseline', () => {
    assert.equal(checkRegistered(fs, workspace, 'http://127.0.0.1:9/').ok, false, 'no baseline means no active scan');
    fs.writeFileSync(path.join(workspace, 'assets.md'), '# 资产\n- http://127.0.0.1:9 已授权\n');
    assert.equal(checkRegistered(fs, workspace, 'http://127.0.0.1:9/').ok, true);
    const other = checkRegistered(fs, workspace, 'http://elsewhere.invalid/');
    assert.equal(other.ok, false, 'a new host must be registered before an active scan');
    assert.match(other.hint, /未登记/);
  });
  test('a newly discovered asset outside the authorized scope is rejected, not silently added', () => {
    const scope = 'example.com, 203.0.113.0/24';
    assert.equal(matchesScope({ host: 'example.com' }, scope), true);
    assert.equal(matchesScope({ host: 'outside.invalid' }, scope), false);
    assert.equal(scopeSafeAsset({ host: 'outside.invalid' }, scope), null);
    // 只授权了 IP/CIDR 时，越界的虚拟主机名被换成在范围里的 IP，而不是照抄出去。
    const rewritten = scopeSafeAsset({ host: 'outside.invalid', ip: '203.0.113.7' }, scope);
    assert.equal(rewritten.host, '203.0.113.7');
    assert.equal(new URL(rewritten.target).hostname, '203.0.113.7');
  });
} finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
