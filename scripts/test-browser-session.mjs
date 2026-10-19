// W04：受管 Chrome for Testing 会话的真实集成验证（本地页面，不访问外部目标）。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startBrowserSession, resolveCftExecutable } from '../plugins/dsh-redteam-results/lib/browser-session.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-browser-session-'));
process.env.DSH_HOME = home;
let failed = 0, skipped = 0;
const test = async (name, work) => {
  try { await work(); console.log('ok   ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); }
};

const cft = process.env.SAKER_CFT_PATH
  || ['E:/software/ChromeForTesting/chrome-win64/chrome.exe', 'E:/software/ChromeForTesting/chrome.exe'].find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } });
delete process.env.SAKER_CFT_PATH;

const server = http.createServer((request, response) => {
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Saker Browser Test</title></head><body>'
      + '<h1 id="title">项目测试页面</h1><input id="name" />'
      + '<button id="go" onclick="document.getElementById(\'title\').textContent=\'已点击\'">执行</button>'
      + '</body></html>');
    return;
  }
  if (request.url === '/api/data') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, marker: 'SAKER_PROJECT_DATA' }));
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

try {
  if (!cft) {
    skipped++;
    console.log('skip Chrome for Testing 不在本机，浏览器集成验证未运行');
  } else {
    await test('真实 CfT 打开本地页面、观察 DOM、点击与输入', async () => {
      const session = await startBrowserSession({ executablePath: cft, identity: 'alice', profileRoot: path.join(home, 'profiles') });
      try {
        const opened = await session.open(origin + '/');
        assert.equal(opened.title, 'Saker Browser Test');
        assert(opened.text.includes('项目测试页面'));
        const element = await session.observe({ selector: '#title' });
        assert.equal(element.element.text, '项目测试页面');
        const clicked = await session.act({ type: 'click', selector: '#go' });
        assert.equal(clicked.found, true);
        const afterClick = await session.observe();
        assert(afterClick.text.includes('已点击'), '点击后 DOM 必须更新');
        const typed = await session.act({ type: 'type', selector: '#name', text: 'alice' });
        assert.equal(typed.value, 'alice');
        assert(session.profileDir.includes('alice'), '身份必须使用独立 profile');
        assert(session.version.includes('Chrome'), '必须记录 CfT 版本：' + session.version);
      } finally { await session.close(); }
    });

    await test('真实 CfT 记录相关请求并可读取响应正文', async () => {
      const session = await startBrowserSession({ executablePath: cft, identity: 'bob', profileRoot: path.join(home, 'profiles') });
      try {
        await session.open(origin + '/api/data');
        const requests = session.listRequests();
        const record = requests.find(item => item.url.endsWith('/api/data'));
        assert(record, '必须记录 /api/data 请求：' + JSON.stringify(requests));
        assert.equal(record.status, 200);
        const detail = await session.requestDetail(record.requestId);
        assert(detail.responseBody.includes('SAKER_PROJECT_DATA'));
        assert.equal(session.profileDir.includes('bob'), true);
      } finally { await session.close(); }
    });

    await test('关闭后会话拒绝继续动作', async () => {
      const session = await startBrowserSession({ executablePath: cft, identity: 'carol', profileRoot: path.join(home, 'profiles') });
      await session.close();
      assert.equal(session.closed, true);
      await assert.rejects(() => session.open(origin + '/'), /已关闭/);
    });

    await test('安全配置「工具」里的 Chrome for Testing 路径可被解析', async () => {
      const profileDir = path.join(home, 'profiles', 'desktop');
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
        '- id: dsh-sec-config',
        '  name: "@dsh-external/dsh-sec-config"',
        '  config:',
        '    entries:',
        '      - key: chrome_for_testing',
        '        path: ' + cft,
        '',
      ].join('\n'));
      const resolved = resolveCftExecutable();
      assert.equal(path.resolve(resolved).toLowerCase(), path.resolve(cft).toLowerCase());
    });
  }

  await test('未配置 CfT 时明确报错，不自动改用个人 Chrome', async () => {
    const isolatedHome = path.join(home, 'no-config-home');
    fs.mkdirSync(isolatedHome, { recursive: true });
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = isolatedHome;
    try {
      assert.throws(() => resolveCftExecutable('E:/definitely-missing/chrome.exe'), /未找到 Chrome for Testing|不会自动改用个人 Chrome/);
      await assert.rejects(() => startBrowserSession({ executablePath: 'E:/definitely-missing/chrome.exe', identity: 'nobody', profileRoot: path.join(home, 'profiles') }), /未找到 Chrome for Testing/);
    } finally { process.env.DSH_HOME = previousHome; }
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log(failed ? failed + ' failed' : skipped ? 'all passed (' + skipped + ' skipped)' : 'all passed');
if (failed) process.exitCode = 1;
