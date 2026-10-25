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
  test('legacy starting points no longer create stages or hidden scan allowances', () => {
    startTaskPolicy(store, 'materials', { mode: 'regular', startMode: 'materials-first', question: '先用已有材料', target: 'http://127.0.0.1:9', budget: { toolCalls: 10 } });
    startTaskPolicy(store, 'scope-only', { mode: 'regular', startMode: 'auto-recon', question: '只给范围，补必要入口', target: 'http://127.0.0.1:9', budget: { toolCalls: 10 } });
    assert.equal(readTaskPolicy(store, 'materials').startMode, 'direct-test');
    assert.equal(readTaskPolicy(store, 'scope-only').startMode, 'direct-test');
    const autoPrompt = taskPrompt({ configured: true, policy: readTaskPolicy(store, 'scope-only'), stopped: false });
    assert(!autoPrompt.includes('起步方式=') && !autoPrompt.includes('自动信息收集'));
    assert.equal(readTaskPolicy(store, 'scope-only').budget.unmeteredToolCalls, null);
    assert.equal(readTaskPolicy(store, 'materials').budget.unmeteredToolCalls, null);
    startTaskPolicy(store, 'auto-zero', { mode: 'regular', startMode: 'auto-recon', budget: { toolCalls: 10, unmeteredToolCalls: 0 } });
    assert.equal(readTaskPolicy(store, 'auto-zero').budget.unmeteredToolCalls, 0, 'an explicit zero remains a user hard cap');
  });
  test('an active scan proceeds inside the user scope without a default allowance', () => {
    const before = readTaskPolicy(store, 'materials');
    assert.equal(taskExecutionGuard(store, 'materials', 'httpx_probe'), undefined);
    const after = readTaskPolicy(store, 'materials');
    assert.equal(after.used.toolCalls, before.used.toolCalls + 1);
    assert.equal(after.used.unmeteredToolCalls, 1);
    assert.equal(taskExecutionGuard(store, 'materials', 'read'), undefined, 'a metered local read is unaffected');
  });
  test('an explicit allowance admits exactly that many unmetered calls and then stops', () => {
    startTaskPolicy(store, 'allowed', { mode: 'regular', target: 'http://127.0.0.1:9', startMode: 'auto-recon', budget: { toolCalls: 10, unmeteredToolCalls: 1 } });
    assert.equal(taskExecutionGuard(store, 'allowed', 'ffuf_fuzz'), undefined);
    assert.equal(readTaskPolicy(store, 'allowed').used.unmeteredToolCalls, 1);
    assert.equal(readTaskPolicy(store, 'allowed').used.toolCalls, 1, 'a scan is still one tool call');
    const denied = taskExecutionGuard(store, 'allowed', 'nuclei_scan');
    assert.match(denied, /unmetered_traffic_budget_exhausted/);
    assert.equal(readTaskPolicy(store, 'allowed').used.unmeteredToolCalls, 1, 'the exhausted allowance must not grow');
    assert.equal(readTaskPolicy(store, 'allowed').used.toolCalls, 1);
    assert(taskPrompt({ configured: true, policy: readTaskPolicy(store, 'allowed'), stopped: false }).includes('未计量通道=1/1'));
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
  test('opaque shell and MCP traffic follows scope without a default quota', () => {
    startTaskPolicy(store, 'shell-open', { mode: 'regular', question: '只查这个入口', target: 'http://127.0.0.1:3000', budget: { toolCalls: 10 } });
    assert.equal(taskExecutionGuard(store, 'shell-open', 'pwsh', Date.now(), { args: { command: 'Get-ChildItem . | Select-Object -First 3' } }), undefined);
    assert.equal(taskExecutionGuard(store, 'shell-open', 'pwsh', Date.now(), { args: { command: 'Invoke-WebRequest http://127.0.0.1:3000/rest/products/search?q=apple' } }), undefined);
    assert.equal(readTaskPolicy(store, 'shell-open').used.unmeteredToolCalls, 1, 'explicit URLs are still counted as opaque target traffic');
    const outside = taskExecutionGuard(store, 'shell-open', 'pwsh', Date.now(), { args: { command: 'curl https://outside.example.org/' } });
    assert.match(String(outside), /outside_scope/);
    assert.equal(readTaskPolicy(store, 'shell-open').used.toolCalls, 2, 'a rejected out-of-scope call is not counted');

    startTaskPolicy(store, 'shell-cap', { mode: 'regular', question: '只查这个入口', target: 'http://127.0.0.1:3000', budget: { toolCalls: 10, unmeteredToolCalls: 1 } });
    assert.equal(taskExecutionGuard(store, 'shell-cap', 'pwsh', Date.now(), { args: { command: 'curl http://127.0.0.1:3000/rest/products/search?q=apple' } }), undefined);
    assert.equal(readTaskPolicy(store, 'shell-cap').used.unmeteredToolCalls, 1, 'optional cap counts opaque calls');
    const mcpArgs = { server: 'yakit', tool: 'batch_do_http_request', args: { 'base-url': 'http://127.0.0.1:3000', method: 'GET', paths: '/a\n/b' } };
    assert.match(String(taskExecutionGuard(store, 'shell-cap', 'mcp_call', Date.now(), { args: mcpArgs })), /unmetered_traffic_budget_exhausted/,
      'the optional cap is shared across shell and MCP channels');
    const splitHostArgs = { server: 'yakit', tool: 'do_http_request', args: { host: '127.0.0.1', port: 3000, path: '/a', isHttps: false } };
    assert.match(String(taskExecutionGuard(store, 'shell-cap', 'mcp_call', Date.now(), { args: splitHostArgs })), /unmetered_traffic_budget_exhausted/);
    const rawHttpArgs = { server: 'yakit', tool: 'do_http_request', args: { request: 'GET /a HTTP/1.1\r\nHost: 127.0.0.1:3000\r\n\r\n' } };
    assert.match(String(taskExecutionGuard(store, 'shell-cap', 'mcp_call', Date.now(), { args: rawHttpArgs })), /unmetered_traffic_budget_exhausted/);
    assert.equal(taskExecutionGuard(store, 'shell-cap', 'mcp_call', Date.now(), { args: { server: 'burp', tool: 'base64_encode', args: { content: 'saker' } } }), undefined);

    startTaskPolicy(store, 'mcp-open', { mode: 'regular', question: '只查这个入口', target: 'http://127.0.0.1:3000', budget: { toolCalls: 10 } });
    assert.equal(taskExecutionGuard(store, 'mcp-open', 'mcp_call', Date.now(), { args: mcpArgs }), undefined);
    assert.equal(readTaskPolicy(store, 'mcp-open').used.unmeteredToolCalls, 1);
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
  test('the retired test-content catalog no longer blocks existing scanner or local tools', () => {
    startTaskPolicy(store, 'closed-collection', { mode: 'regular', target: 'http://127.0.0.1:9', startMode: 'auto-recon', budget: { toolCalls: 10, unmeteredToolCalls: 5 } });
    setModules('closed-collection', ALL.filter(key => key !== 'fingerprint'));
    assert.equal(taskExecutionGuard(store, 'closed-collection', 'httpx_probe'), undefined);
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
