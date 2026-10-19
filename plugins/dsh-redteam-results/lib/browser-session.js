// W04：受管 Chrome for Testing 长生命周期会话。只使用显式配置的 CfT，
// 不自动回退到个人 Chrome；每个身份使用独立 profile，请求修改只在明确设置时启用。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 读取安全配置「工具」里 key 含 chrome 的条目路径（profile 的 cordis.patch.yml）。 */
function cftFromProfileConfig(home) {
  const profiles = path.join(home, 'profiles');
  let names = [];
  try { names = fs.readdirSync(profiles); } catch { return ''; }
  for (const name of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(profiles, name, 'cordis.patch.yml'), 'utf8'); } catch { continue; }
    const keyRe = /key:\s*["']?([A-Za-z0-9_]*chrome[A-Za-z0-9_]*)["']?/gi;
    let match;
    while ((match = keyRe.exec(text)) !== null) {
      const pathMatch = /path:\s*["']?([^"'\r\n]+)/i.exec(text.slice(match.index, match.index + 500));
      if (pathMatch) return pathMatch[1].trim();
    }
  }
  return '';
}

export function resolveCftExecutable(explicit) {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  const candidates = [
    explicit,
    process.env.SAKER_CFT_PATH,
    cftFromProfileConfig(home),
    path.join(home, 'tools', 'chrome-for-testing', 'chrome.exe'),
    path.join(home, 'tools', 'chrome-for-testing', 'chrome-win64', 'chrome.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return path.resolve(candidate); } catch { /* 继续找 */ }
  }
  throw new Error('未找到 Chrome for Testing：请在「安全配置 → 工具」添加 Chrome for Testing 并填写路径，或设置 SAKER_CFT_PATH；Saker 不会自动改用个人 Chrome');
}

export function cftVersion(executable) {
  return new Promise(resolve => {
    const child = spawn(executable, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let output = '';
    let done = false;
    const finish = value => { if (done) return; done = true; try { child.kill(); } catch { /* 已退出 */ } resolve(value); };
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.once('error', () => finish(''));
    child.once('exit', () => finish(output.trim()));
    setTimeout(() => finish(output.trim()), 3000);
  });
}

function waitForDevtoolsUrl(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Chrome for Testing 启动超时（未拿到 DevTools 地址）')), timeoutMs);
    const onData = chunk => {
      buffer += chunk.toString();
      const match = /ws:\/\/[^\s]+/.exec(buffer);
      if (match) { clearTimeout(timer); child.stderr.off('data', onData); resolve(match[0]); }
    };
    child.stderr.on('data', onData);
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Chrome for Testing 提前退出（code=' + code + '）')); });
  });
}

async function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let serial = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
      return;
    }
    if (message.method) for (const handler of listeners.get(message.method) || []) handler(message.params || {});
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  return {
    call: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    }),
    on: (method, handler) => {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(handler);
      return () => listeners.set(method, (listeners.get(method) || []).filter(item => item !== handler));
    },
    close: () => { try { socket.close(); } catch { /* 已关闭 */ } },
  };
}

const safeName = value => String(value || 'default').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'default';

export class BrowserSession {
  constructor(options) {
    Object.assign(this, options);
    this.closed = false;
    this.requests = new Map();
    this.requestOrder = [];
    this.override = null;
  }

  static async start(options = {}) {
    const executable = resolveCftExecutable(options.executablePath);
    const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
    const profileRoot = path.resolve(options.profileRoot || path.join(home, 'project-browser'));
    const profileDir = path.join(profileRoot, safeName(options.identity));
    fs.mkdirSync(profileDir, { recursive: true });
    const child = spawn(executable, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--remote-debugging-port=0', '--user-data-dir=' + profileDir,
      '--disable-background-networking', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const wsUrl = await waitForDevtoolsUrl(child, options.timeoutMs || 20000);
    const base = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
    const target = await (await fetch(base + '/json/new?about:blank', { method: 'PUT' })).json();
    const client = await connectCdp(target.webSocketDebuggerUrl);
    await client.call('Page.enable').catch(() => {});
    await client.call('Runtime.enable').catch(() => {});
    await client.call('Network.enable').catch(() => {});
    const versionInfo = await client.call('Browser.getVersion').catch(() => null);
    const version = String(versionInfo?.product || '');
    const session = new BrowserSession({ child, base, target, client, executable, version, profileDir, identity: safeName(options.identity) });
    session.watchNetwork();
    return session;
  }

  watchNetwork() {
    this.client.on('Network.requestWillBeSent', params => {
      const id = params.requestId;
      if (!this.requests.has(id)) this.requestOrder.push(id);
      this.requests.set(id, {
        requestId: id, url: params.request?.url || '', method: params.request?.method || '',
        headers: params.request?.headers || {}, postData: params.request?.postData || '',
        status: null, responseHeaders: {}, mimeType: '', fromCache: false, at: new Date().toISOString(),
      });
    });
    this.client.on('Network.responseReceived', params => {
      const record = this.requests.get(params.requestId);
      if (!record) return;
      record.status = params.response?.status ?? null;
      record.responseHeaders = params.response?.headers || {};
      record.mimeType = params.response?.mimeType || '';
      record.fromCache = params.response?.fromDiskCache === true || params.response?.fromServiceWorker === true;
    });
  }

  async open(url) {
    this.assertOpen();
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('浏览器只接受 HTTP(S) URL');
    const loaded = new Promise(resolve => {
      const off = this.client.on('Page.loadEventFired', () => { off(); resolve(true); });
      setTimeout(() => { off(); resolve(false); }, 15000);
    });
    await this.client.call('Page.navigate', { url });
    await loaded;
    await sleep(250);
    return this.observe();
  }

  async observe({ selector = '', screenshot = false } = {}) {
    this.assertOpen();
    const info = await this.client.call('Runtime.evaluate', {
      expression: '(function(){return {title:document.title,url:location.href,text:(document.body?document.body.innerText:"").slice(0,4000)}})()',
      returnByValue: true,
    });
    const out = { ...(info.result?.value || {}), observedAt: new Date().toISOString() };
    if (selector) {
      const element = await this.client.call('Runtime.evaluate', {
        expression: '(function(){var e=document.querySelector(' + JSON.stringify(selector) + ');if(!e)return null;var r=e.getBoundingClientRect();return {tag:e.tagName,text:(e.innerText||e.value||"").slice(0,500),visible:r.width>0&&r.height>0}})()',
        returnByValue: true,
      });
      out.element = element.result?.value ?? null;
    }
    if (screenshot) {
      const shot = await this.client.call('Page.captureScreenshot', { format: 'png' });
      out.screenshotBase64 = shot.data;
    }
    return out;
  }

  async act(action = {}) {
    this.assertOpen();
    const type = String(action.type || '');
    if (type === 'navigate') return this.open(action.url);
    if (type === 'click') {
      const result = await this.client.call('Runtime.evaluate', {
        expression: '(function(){var e=document.querySelector(' + JSON.stringify(String(action.selector || '')) + ');if(!e)return {found:false};e.click();return {found:true,tag:e.tagName}})()',
        returnByValue: true,
      });
      return result.result?.value || { found: false };
    }
    if (type === 'type') {
      const result = await this.client.call('Runtime.evaluate', {
        expression: '(function(){var e=document.querySelector(' + JSON.stringify(String(action.selector || '')) + ');if(!e)return {found:false};e.focus();e.value=' + JSON.stringify(String(action.text ?? '')) + ';e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return {found:true,value:e.value}})()',
        returnByValue: true,
      });
      return result.result?.value || { found: false };
    }
    if (type === 'select') {
      const result = await this.client.call('Runtime.evaluate', {
        expression: '(function(){var e=document.querySelector(' + JSON.stringify(String(action.selector || '')) + ');if(!e)return {found:false};e.value=' + JSON.stringify(String(action.value ?? '')) + ';e.dispatchEvent(new Event("change",{bubbles:true}));return {found:true,value:e.value}})()',
        returnByValue: true,
      });
      return result.result?.value || { found: false };
    }
    if (type === 'upload') {
      const document = await this.client.call('DOM.getDocument', { depth: -1 });
      const node = await this.client.call('DOM.querySelector', { nodeId: document.root.nodeId, selector: String(action.selector || '') });
      if (!node.nodeId) return { found: false };
      await this.client.call('DOM.setFileInputFiles', { nodeId: node.nodeId, files: (action.files || []).map(file => path.resolve(String(file))) });
      return { found: true, files: (action.files || []).length };
    }
    if (type === 'download') {
      const directory = path.resolve(String(action.directory || path.join(process.env.DSH_HOME || '.', 'downloads')));
      fs.mkdirSync(directory, { recursive: true });
      await this.client.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
      return { directory };
    }
    if (type === 'dialog') {
      await this.client.call('Page.handleJavaScriptDialog', { accept: action.accept !== false, promptText: action.promptText });
      return { handled: true };
    }
    throw new Error('不支持的浏览器动作：' + type);
  }

  listRequests({ limit = 100 } = {}) {
    return this.requestOrder.slice(-limit).map(id => {
      const record = this.requests.get(id);
      const { postData, headers, ...summary } = record;
      return { ...summary, hasPostData: !!postData, headerCount: Object.keys(headers || {}).length };
    });
  }

  async requestDetail(requestId) {
    this.assertOpen();
    const record = this.requests.get(String(requestId));
    if (!record) throw new Error('未找到该请求记录：' + requestId);
    let body = '';
    try { body = (await this.client.call('Network.getResponseBody', { requestId: String(requestId) })).body || ''; }
    catch { body = ''; }
    return { ...record, responseBody: body.slice(0, 20000), responseBodyTruncated: body.length > 20000 };
  }

  /** 只对明确匹配的请求做修改；动作结束或关闭时解除拦截。 */
  async setRequestOverride({ urlPattern = '*', headers = {}, postData } = {}) {
    this.assertOpen();
    await this.clearRequestOverride();
    this.override = { urlPattern, headers, postData };
    await this.client.call('Fetch.enable', { patterns: [{ urlPattern, requestStage: 'Request' }] });
    this.client.on('Fetch.requestPaused', async params => {
      try {
        const request = { requestId: params.requestId, headers: { ...(params.request?.headers || {}), ...headers } };
        if (postData !== undefined) request.postData = String(postData);
        await this.client.call('Fetch.continueRequest', request);
      } catch {
        try { await this.client.call('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' }); } catch { /* 已结束 */ }
      }
    });
    return { active: true, urlPattern };
  }

  async clearRequestOverride() {
    if (!this.override) return { active: false };
    this.override = null;
    try { await this.client.call('Fetch.disable'); } catch { /* 未启用 */ }
    return { active: false };
  }

  assertOpen() {
    if (this.closed) throw new Error('浏览器会话已关闭');
    if (this.child.exitCode !== null) throw new Error('Chrome for Testing 已退出（code=' + this.child.exitCode + '）');
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.clearRequestOverride(); } catch { /* 忽略 */ }
    try { this.client.close(); } catch { /* 已关闭 */ }
    try { this.child.kill(); } catch { /* 已退出 */ }
    await sleep(200);
  }
}

export async function startBrowserSession(options = {}) {
  return BrowserSession.start(options);
}
