// W04：受管 Chrome for Testing 会话的真实集成验证（本地页面，不访问外部目标）。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { BrowserSession, startBrowserSession, resolveCftExecutable } from '../plugins/dsh-redteam-results/lib/browser-session.js';

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
  if (request.url === '/redirect') {
    response.writeHead(302, { location: outsideOrigin + '/outside-redirect' });
    response.end();
    return;
  }
  if (request.url === '/cross') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>cross</title><body>allowed page'
      + '<iframe src="' + outsideOrigin + '/outside-frame"></iframe>'
      + '<script>fetch(' + JSON.stringify(outsideOrigin + '/outside-xhr') + ').catch(function(){})</script></body>');
    return;
  }
  if (request.url === '/popup') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>popup</title><body>allowed popup host'
      + '<script>window.open(' + JSON.stringify(outsideOrigin + '/outside-popup') + ',\'_blank\')</script></body>');
    return;
  }
  if (request.url === '/secret') {
    response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'audit_cookie=SYNTHETIC_SET_COOKIE; HttpOnly' });
    response.end(JSON.stringify({ password: 'SYNTHETIC_PASSWORD', access_token: 'SYNTHETIC_TOKEN', business: 'VISIBLE_BUSINESS_VALUE' }));
    return;
  }
  if (request.url === '/dialog') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>dialog</title><body><script>alert("SAKER_DIALOG")</script></body>');
    return;
  }
  if (request.url === '/upload') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>upload</title><body><input id="file" type="file"></body>');
    return;
  }
  if (request.url === '/download') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>download</title><body><a id="get" href="/download.bin">download</a></body>');
    return;
  }
  if (request.url === '/download.bin') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="proof.bin"' });
    response.end(Buffer.from('SAKER_DOWNLOAD_CONTENT'));
    return;
  }
  if (request.url === '/many') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>many</title><body><script>Promise.all(Array.from({length:110},function(_,i){return fetch("/bulk/"+i).catch(function(){})}))</script></body>');
    return;
  }
  if (request.url.startsWith('/bulk/')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ index: request.url }));
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('not found');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let outsideRequests = 0;
const outside = http.createServer((request, response) => {
  outsideRequests++;
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('OUTSIDE');
});
await new Promise(resolve => outside.listen(0, '127.0.0.1', resolve));
const outsideOrigin = 'http://127.0.0.1:' + outside.address().port;

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
      let pendingError = null;
      const pending = session.client.call('Runtime.evaluate', { expression: 'new Promise(function(){})', awaitPromise: true })
        .catch(error => { pendingError = error; });
      await session.close();
      await pending;
      assert.match(String(pendingError?.message), /关闭|超时|CDP/);
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

    await test('真实 CfT 在请求发出前阻断跨站跳转、iframe 与 XHR', async () => {
      const allowed = new Set([new URL(origin).origin]);
      const session = await startBrowserSession({
        executablePath: cft, identity: 'guard', profileRoot: path.join(home, 'profiles'),
        requestGuard: ({ url }) => {
          let parsed; try { parsed = new URL(url); } catch { return { denial: 'invalid-url' }; }
          return allowed.has(parsed.origin) ? { policy: { requestRatePerMinute: 600, requestConcurrency: 2 } } : { denial: 'outside-origin' };
        },
        pacingSessionId: 'browser-guard-test',
      });
      try {
        outsideRequests = 0;
        await assert.rejects(() => session.open(origin + '/redirect'), /策略阻断|outside-origin/);
        assert.equal(outsideRequests, 0, '非法跳转必须在到达目标前被阻断');
        await assert.rejects(() => session.open(origin + '/cross'), /策略阻断|outside-origin/);
        assert.equal(outsideRequests, 0, 'iframe/XHR 非法请求必须在到达目标前被阻断');
        await session.open(origin + '/popup').catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(outsideRequests, 0, '新窗口请求也必须在到达目标前被阻断');
        const allowedPage = await session.open(origin + '/api/data');
        assert(allowedPage.text.includes('SAKER_PROJECT_DATA'));
      } finally { await session.close(); }
    });

    await test('浏览器请求列表与详情遮蔽 Cookie、Set-Cookie 和 JSON 凭据', async () => {
      const session = await startBrowserSession({
        executablePath: cft, identity: 'redact', profileRoot: path.join(home, 'profiles'),
        requestGuard: ({ url }) => new URL(url).origin === origin ? { policy: { requestRatePerMinute: 600, requestConcurrency: 2 } } : { denial: 'outside-origin' },
        pacingSessionId: 'browser-redact-test',
      });
      try {
        await session.open(origin + '/secret');
        const record = session.listRequests().find(item => item.url.endsWith('/secret'));
        assert(record);
        assert(!JSON.stringify(record).includes('SYNTHETIC_SET_COOKIE'));
        const detail = await session.requestDetail(record.requestId);
        assert(!JSON.stringify(detail).includes('SYNTHETIC_PASSWORD'));
        assert(!JSON.stringify(detail).includes('SYNTHETIC_TOKEN'));
        assert(detail.responseBody.includes('VISIBLE_BUSINESS_VALUE'), '非秘密业务正文仍应可分析');
      } finally { await session.close(); }
    });

    await test('确定性浏览器记录遮蔽 Set-Cookie 并保留正文不可得原因', async () => {
      const browser = new BrowserSession({
        child: { exitCode: null },
        client: { call: async () => { throw new Error('body evicted'); } },
      });
      browser.requestOrder = ['r1'];
      browser.requests.set('r1', {
        requestId: 'r1', url: origin + '/secret?token=SYNTHETIC_URL_TOKEN', method: 'GET',
        headers: { Cookie: 'SYNTHETIC_REQUEST_COOKIE' }, postData: '',
        responseHeaders: { 'Set-Cookie': 'SYNTHETIC_RESPONSE_COOKIE' }, status: 200,
      });
      const listed = browser.listRequests();
      assert.equal(listed[0].responseHeaders['Set-Cookie'], '[已遮蔽]');
      assert(!JSON.stringify(listed).includes('SYNTHETIC_RESPONSE_COOKIE'));
      assert(!JSON.stringify(listed).includes('SYNTHETIC_URL_TOKEN'));
      const detail = await browser.requestDetail('r1');
      assert.equal(detail.headers.Cookie, '[已遮蔽]');
      assert.equal(detail.responseHeaders['Set-Cookie'], '[已遮蔽]');
      assert.equal(detail.bodyUnavailable, 'body evicted');
    });

    await test('浏览器二进制正文保留 base64 标志和捕获字节', async () => {
      const browser = new BrowserSession({
        child: { exitCode: null },
        client: { call: async () => ({ body: 'AAECAwQ=', base64Encoded: true }) },
      });
      browser.requests.set('r2', { requestId: 'r2', url: origin + '/binary', status: 200, headers: {}, responseHeaders: {} });
      const detail = await browser.requestDetail('r2');
      assert.equal(detail.binary, true);
      assert.equal(detail.responseBodyEncoding, 'base64');
      assert.equal(detail.responseBodyBase64, 'AAECAwQ=');
      assert.equal(detail.capturedBytes, 8);
    });

    await test('真实 CfT 失败元素、弹窗、上传、下载和请求分页可核对', async () => {
      const session = await startBrowserSession({ executablePath: cft, identity: 'files', profileRoot: path.join(home, 'profiles') });
      try {
        await session.open(origin + '/');
        const missing = await session.act({ type: 'click', selector: '#missing' });
        assert.equal(missing.state, 'failed');
        assert.equal(missing.error, 'element-not-found');

        const dialog = await session.open(origin + '/dialog');
        assert.equal(dialog.dialog.message, 'SAKER_DIALOG');
        const handled = await session.act({ type: 'dialog', accept: true });
        assert.equal(handled.handled, true);

        const uploadFile = path.join(home, 'upload-proof.txt');
        fs.writeFileSync(uploadFile, 'SAKER_UPLOAD_CONTENT');
        await session.open(origin + '/upload');
        const uploaded = await session.act({ type: 'upload', selector: '#file', files: [uploadFile] });
        assert.equal(uploaded.state, 'completed');
        assert.equal(uploaded.verifiedFiles[0], uploadFile);

        const directory = path.join(home, 'downloads');
        await session.open(origin + '/download');
        const downloaded = await session.act({ type: 'download', selector: '#get', directory });
        assert.equal(downloaded.completed, true, JSON.stringify(downloaded));
        assert(fs.existsSync(downloaded.file), JSON.stringify(downloaded));
        assert.equal(fs.readFileSync(downloaded.file, 'utf8'), 'SAKER_DOWNLOAD_CONTENT');

        await session.open(origin + '/many');
        await new Promise(resolve => setTimeout(resolve, 500));
        const first = session.listRequestsPage({ cursor: 0, limit: 40 });
        const second = session.listRequestsPage({ cursor: first.nextCursor, limit: 40 });
        assert(first.total > 100, '请求总数应超过旧实现的最后 100 条窗口');
        assert(first.nextCursor !== null);
        assert(second.entries.length > 0);
        assert(!second.entries.some(item => first.entries.some(prior => prior.requestId === item.requestId)), '分页不能重复同一请求');
      } finally { await session.close(); }
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
  outside.closeAllConnections?.();
  await new Promise(resolve => outside.close(resolve));
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log(failed ? failed + ' failed' : skipped ? 'all passed (' + skipped + ' skipped)' : 'all passed');
if (failed) process.exitCode = 1;
