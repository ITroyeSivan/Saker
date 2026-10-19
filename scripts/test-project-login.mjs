// A13/A14：受控登录页验证 CfT 登录与会话保持、身份隔离，以及 200 登录页不被自动判成结论。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startBrowserSession } from '../plugins/dsh-redteam-results/lib/browser-session.js';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createProjectRun, transitionProjectRun, defineProjectChecks, readProjectCheck } from '../plugins/dsh-redteam-results/lib/project-store.js';
import { executeProjectHttp } from '../plugins/dsh-redteam-results/lib/project-execution.js';
import { readExecutionReceipt } from '../plugins/dsh-redteam-results/lib/execution-receipts.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-project-login-'));
process.env.DSH_HOME = home;
const cft = process.env.SAKER_CFT_PATH
  || ['E:/software/ChromeForTesting/chrome-win64/chrome.exe', 'E:/software/ChromeForTesting/chrome.exe'].find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } });
if (!cft) {
  console.log('skip Chrome for Testing 不在本机，登录验收未运行');
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(0);
}

const LOGIN_HTML = '<!doctype html><html><head><title>登录</title></head><body><h1>请登录</h1>'
  + '<form method="post" action="/login"><input id="user" name="user" /><input id="pass" name="pass" type="password" />'
  + '<button id="submit" type="submit">登录</button></form></body></html>';
const server = http.createServer((request, response) => {
  const cookie = request.headers.cookie || '';
  if (request.url === '/login' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(LOGIN_HTML);
    return;
  }
  if (request.url === '/login' && request.method === 'POST') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const params = new URLSearchParams(body);
      if (params.get('user') === 'alice' && params.get('pass') === 'secret') {
        response.writeHead(200, { 'set-cookie': 'saker_session=ok; Path=/', 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><body><h1>欢迎 alice</h1></body></html>');
      } else {
        response.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><body><h1>登录失败</h1></body></html>');
      }
    });
    return;
  }
  if (request.url === '/private') {
    // A14：未登录时仍返回 200 登录页，状态码不能单独证明访问成功。
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(/saker_session=ok/.test(cookie) ? '<html><body><h1>私有资料 SAKER_PRIVATE_OK</h1></body></html>' : LOGIN_HTML);
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => { try { await work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function prepareProject(sid) {
  startTaskPolicy(store, sid, { scenario: 'project', question: '登录验收', target: origin, budget: { minutes: 10 } });
  const run = createProjectRun(store, sid, { question: '登录验收' });
  const running = transitionProjectRun(store, sid, run.runId, 'running', run.controlRev);
  const [check] = defineProjectChecks(store, sid, run.runId, [{ requirement: '检查登录后私有资料' }]);
  return { run: running, check };
}

try {
  await test('A13 CfT 正常账号密码登录并保持会话', async () => {
    const browser = await startBrowserSession({ executablePath: cft, identity: 'alice', profileRoot: path.join(home, 'profiles') });
    try {
      await browser.open(origin + '/login');
      await browser.act({ type: 'type', selector: '#user', text: 'alice' });
      await browser.act({ type: 'type', selector: '#pass', text: 'secret' });
      await browser.act({ type: 'click', selector: '#submit' });
      await sleep(600);
      const afterLogin = await browser.observe();
      assert(afterLogin.text.includes('欢迎 alice'), '登录后必须看到欢迎页：' + afterLogin.text.slice(0, 200));
      await browser.open(origin + '/private');
      const privatePage = await browser.observe();
      assert(privatePage.text.includes('SAKER_PRIVATE_OK'), '登录会话必须保持：' + privatePage.text.slice(0, 200));
    } finally { await browser.close(); }
  });

  await test('A13 不同身份使用独立 profile，不共享 Cookie', async () => {
    const anonymous = await startBrowserSession({ executablePath: cft, identity: 'anonymous', profileRoot: path.join(home, 'profiles') });
    try {
      await anonymous.open(origin + '/private');
      const page = await anonymous.observe();
      assert(!page.text.includes('SAKER_PRIVATE_OK'), '匿名会话不能读到 alice 的私有资料');
      assert(page.text.includes('登录'), '未登录应看到登录页');
    } finally { await anonymous.close(); }
  });

  await test('A14 200 登录页被保存为真实回执，但程序不自动写结论', async () => {
    const { run, check } = prepareProject('pl-http');
    const result = await executeProjectHttp(store, 'pl-http', run.runId, check.checkId, { method: 'GET', url: origin + '/private' });
    assert.equal(result.status, 200);
    const receipt = readExecutionReceipt(store, 'pl-http', result.executionId);
    const body = Buffer.from(receipt.responseBodyBase64, 'base64').toString();
    assert(body.includes('登录'), '回执必须保存真实登录页正文');
    const saved = readProjectCheck(store, 'pl-http', run.runId, check.checkId);
    assert.equal(saved.verdict, '', '程序不能因 200 自动写未发现问题');
    assert.equal(saved.executionState, 'running', '派发后检查仍处于执行中，等待模型判断');
  });
} finally {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
  store.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log(failed ? failed + ' failed' : 'all passed');
if (failed) process.exitCode = 1;
