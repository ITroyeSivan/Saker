// W04：受管 Chrome for Testing 长生命周期会话。只使用显式配置的 CfT，
// 不自动回退到个人 Chrome；每个身份使用独立 profile，请求修改只在明确设置时启用。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acquireTargetSlot } from './request-pacing.js';
import { redactHeaders, redactText } from './redaction.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const dshHome = () => process.env.DSH_HOME || DSH_HOME;

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
  const home = dshHome();
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
  const rejectPending = error => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  socket.onmessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id);
      clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
      return;
    }
    if (message.method) for (const handler of listeners.get(message.method) || []) handler(message.params || {});
  };
  socket.onclose = () => rejectPending(new Error('浏览器 CDP 连接已关闭'));
  socket.onerror = event => rejectPending(new Error('浏览器 CDP 连接错误' + (event?.message ? '：' + event.message : '')));
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onerror = event => rejectPending(new Error('浏览器 CDP 连接错误' + (event?.message ? '：' + event.message : '')));
  return {
    call: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('浏览器 CDP 调用超时：' + method));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
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
    this.policyDenials = [];
    this.pacingReleases = new Map();
    this.guardAbort = new AbortController();
    this.downloads = new Map();
    this.pendingDialog = null;
    this.requestIndexLimit = 5000;
  }

  static async start(options = {}) {
    const executable = resolveCftExecutable(options.executablePath);
    const home = dshHome();
    const profileRoot = path.resolve(options.profileRoot || path.join(home, 'project-browser'));
    const profileIdentity = options.identityRef
      ? String(options.identity || 'default') + '-' + String(options.identityRef)
      : options.identity;
    const profileDir = path.join(profileRoot, safeName(profileIdentity));
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
    await client.call('Network.setBypassServiceWorker', { bypass: true }).catch(() => {});
    const versionInfo = await client.call('Browser.getVersion').catch(() => null);
    const version = String(versionInfo?.product || '');
    const identityRef = String(options.identityRef || '').trim();
    const session = new BrowserSession({
      child, base, target, client, executable, version, profileDir,
      identity: safeName(options.identity),
      identityRef,
      requestGuard: options.requestGuard,
      pacingSessionId: options.pacingSessionId,
    });
    session.watchNetwork();
    await session.watchPolicy();
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
      while (this.requestOrder.length > this.requestIndexLimit) {
        const expired = this.requestOrder.shift();
        this.requests.delete(expired);
      }
    });
    this.client.on('Network.responseReceived', params => {
      const record = this.requests.get(params.requestId);
      if (!record) return;
      record.status = params.response?.status ?? null;
      record.responseHeaders = params.response?.headers || {};
      record.mimeType = params.response?.mimeType || '';
      record.fromCache = params.response?.fromDiskCache === true || params.response?.fromServiceWorker === true;
    });
    this.client.on('Network.responseReceivedExtraInfo', params => {
      const record = this.requests.get(params.requestId);
      if (!record) return;
      record.responseHeaders = { ...(record.responseHeaders || {}), ...(params.headers || {}) };
      if (params.statusCode) record.status = params.statusCode;
    });
    const releasePaced = params => {
      const key = String(params.networkId || params.requestId || '');
      const release = this.pacingReleases.get(key);
      if (release) { release(); this.pacingReleases.delete(key); }
    };
    this.client.on('Network.loadingFinished', releasePaced);
    this.client.on('Network.loadingFailed', releasePaced);
    this.client.on('Page.javascriptDialogOpening', params => { this.pendingDialog = { ...params, at: new Date().toISOString() }; });
    this.client.on('Page.javascriptDialogClosed', () => { this.pendingDialog = null; });
    this.client.on('Browser.downloadWillBegin', params => {
      this.downloads.set(params.guid, {
        guid: params.guid, suggestedFilename: params.suggestedFilename || '',
        state: 'inProgress', receivedBytes: 0, totalBytes: params.totalBytes || 0,
        startedAt: new Date().toISOString(),
      });
    });
    this.client.on('Browser.downloadProgress', params => {
      const current = this.downloads.get(params.guid) || { guid: params.guid };
      this.downloads.set(params.guid, {
        ...current, state: params.state, receivedBytes: params.receivedBytes || 0,
        totalBytes: params.totalBytes || current.totalBytes || 0,
        completedAt: params.state === 'completed' ? new Date().toISOString() : current.completedAt,
        error: params.state === 'canceled' ? 'download-canceled' : current.error,
      });
    });
  }

  recordPolicyDenial(params, denial, phase) {
    const denialRecord = {
      url: redactText(params.request?.url || ''),
      method: String(params.request?.method || '').toUpperCase(),
      resourceType: String(params.resourceType || ''),
      reason: redactText(denial),
      phase,
      at: new Date().toISOString(),
    };
    this.policyDenials.push(denialRecord);
    if (this.policyDenials.length > 500) this.policyDenials.splice(0, this.policyDenials.length - 500);
    return denialRecord;
  }

  async watchPolicy() {
    this.client.on('Fetch.requestPaused', async params => {
      let release = null;
      const key = String(params.networkId || params.requestId || '');
      try {
        const rawUrl = String(params.request?.url || '');
        let parsed;
        try { parsed = new URL(rawUrl); } catch { parsed = null; }
        if (parsed && !['http:', 'https:'].includes(parsed.protocol)) {
          await this.client.call('Fetch.continueRequest', { requestId: params.requestId });
          return;
        }
        const method = String(params.request?.method || 'GET').toUpperCase();
        let decision = null;
        if (typeof this.requestGuard === 'function') {
          decision = await this.requestGuard({
            url: rawUrl, method, resourceType: String(params.resourceType || ''),
            requestId: key, frameId: params.frameId || '',
          });
        }
        const denial = typeof decision === 'string' ? decision : decision?.denial;
        if (denial) {
          this.recordPolicyDenial(params, denial, 'before-dispatch');
          await this.client.call('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' });
          return;
        }
        if (this.pacingSessionId && decision?.policy) {
          release = await acquireTargetSlot(this.pacingSessionId, decision.policy, this.guardAbort.signal);
          if (key) this.pacingReleases.set(key, release);
        }
        await this.client.call('Fetch.continueRequest', { requestId: params.requestId });
      } catch (error) {
        try { release?.(); } catch { /* 已释放 */ }
        if (key) this.pacingReleases.delete(key);
        this.recordPolicyDenial(params, redactText(error?.message || error), 'guard-error');
        try { await this.client.call('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }); } catch { /* 已结束 */ }
      }
    });
    await this.client.call('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      handleAuthRequests: false,
    });
  }

  async open(url) {
    this.assertOpen();
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('浏览器只接受 HTTP(S) URL');
    const denialStart = this.policyDenials.length;
    const loaded = new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        offLoad(); offDialog(); clearTimeout(timer);
        resolve(value);
      };
      const offLoad = this.client.on('Page.loadEventFired', () => finish('load'));
      const offDialog = this.client.on('Page.javascriptDialogOpening', () => finish('dialog'));
      const timer = setTimeout(() => finish('timeout'), 15000);
    });
    const navigation = await this.client.call('Page.navigate', { url });
    await loaded;
    await sleep(250);
    const denied = this.policyDenials.slice(denialStart);
    if (denied.length) throw new Error('浏览器请求在到达目标前被策略阻断：' + denied[0].reason);
    if (navigation?.errorText) throw new Error('浏览器导航失败：' + redactText(navigation.errorText));
    const page = this.pendingDialog
      ? { title: '', url, text: '', observedAt: new Date().toISOString(), dialog: { ...this.pendingDialog } }
      : await this.observe();
    return page;
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
    if (this.pendingDialog && type !== 'dialog')
      return { state: 'failed', error: 'javascript-dialog-pending', dialog: { ...this.pendingDialog } };
    const denialStart = this.policyDenials.length;
    if (type === 'click') {
      const result = await this.client.call('Runtime.evaluate', {
        expression: '(function(){var e=document.querySelector(' + JSON.stringify(String(action.selector || '')) + ');if(!e)return {found:false};e.click();return {found:true,tag:e.tagName}})()',
        returnByValue: true,
      });
      await sleep(250);
      const denied = this.policyDenials.slice(denialStart);
      if (denied.length) throw new Error('浏览器动作触发的请求被策略阻断：' + denied[0].reason);
      const value = result.result?.value || { found: false };
      return value.found === false ? { ...value, state: 'failed', error: 'element-not-found' } : { ...value, state: 'completed' };
    }
    if (type === 'type') {
      const result = await this.client.call('Runtime.evaluate', {
        expression: '(function(){var e=document.querySelector(' + JSON.stringify(String(action.selector || '')) + ');if(!e)return {found:false};e.focus();e.value=' + JSON.stringify(String(action.text ?? '')) + ';e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return {found:true,value:e.value}})()',
        returnByValue: true,
      });
      const value = result.result?.value || { found: false };
      return value.found === false ? { ...value, state: 'failed', error: 'element-not-found' } : { ...value, state: 'completed' };
    }
    if (type === 'select') {
      const result = await this.client.call('Runtime.evaluate', {
        expression: '(function(){var e=document.querySelector(' + JSON.stringify(String(action.selector || '')) + ');if(!e)return {found:false};e.value=' + JSON.stringify(String(action.value ?? '')) + ';e.dispatchEvent(new Event("change",{bubbles:true}));return {found:true,value:e.value}})()',
        returnByValue: true,
      });
      const value = result.result?.value || { found: false };
      return value.found === false ? { ...value, state: 'failed', error: 'element-not-found' } : { ...value, state: 'completed' };
    }
    if (type === 'upload') {
      const document = await this.client.call('DOM.getDocument', { depth: -1 });
      const node = await this.client.call('DOM.querySelector', { nodeId: document.root.nodeId, selector: String(action.selector || '') });
      if (!node.nodeId) return { found: false, state: 'failed', error: 'element-not-found' };
      const files = (action.files || []).map(file => path.resolve(String(file)));
      for (const file of files) {
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        if (!stat?.isFile()) return { found: true, state: 'failed', error: 'upload-file-missing', file };
      }
      await this.client.call('DOM.setFileInputFiles', { nodeId: node.nodeId, files });
      return { found: true, state: 'completed', files: files.length, verifiedFiles: files };
    }
    if (type === 'download') {
      const directory = path.resolve(String(action.directory || path.join(dshHome(), 'downloads')));
      fs.mkdirSync(directory, { recursive: true });
      await this.client.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory, eventsEnabled: true });
      const before = new Set(this.downloads.keys());
      if (!action.selector) return { state: 'listening', directory, completed: false, note: '下载监听已建立；尚未发生下载，不能视为下载完成' };
      const clicked = await this.act({ type: 'click', selector: action.selector });
      if (clicked.state === 'failed') return clicked;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const completed = [...this.downloads.values()].find(item => !before.has(item.guid) && item.state === 'completed');
        const failed = [...this.downloads.values()].find(item => !before.has(item.guid) && item.state === 'canceled');
        if (completed) return {
          state: 'completed', completed: true, directory, guid: completed.guid,
          filename: completed.suggestedFilename, file: path.join(directory, completed.suggestedFilename),
          receivedBytes: completed.receivedBytes, totalBytes: completed.totalBytes,
        };
        if (failed) return { state: 'failed', completed: false, error: failed.error, download: failed };
        await sleep(100);
      }
      return { state: 'failed', completed: false, error: 'download-timeout', directory };
    }
    if (type === 'dialog') {
      await this.client.call('Page.handleJavaScriptDialog', { accept: action.accept !== false, promptText: action.promptText });
      const dialog = this.pendingDialog;
      this.pendingDialog = null;
      return { handled: true, state: 'completed', dialog };
    }
    throw new Error('不支持的浏览器动作：' + type);
  }

  listRequestsPage({ limit = 100, cursor = 0 } = {}) {
    const size = Math.max(1, Math.min(100, Number(limit) || 100));
    const offset = Math.max(0, Number(cursor) || 0);
    const ids = this.requestOrder.slice(offset, offset + size);
    const entries = ids.map(id => {
      const record = this.requests.get(id);
      if (!record) return { requestId: id, unavailable: 'request-index-evicted' };
      const { postData, headers, responseHeaders, ...summary } = record;
      return {
        ...summary, url: redactText(summary.url),
        responseHeaders: redactHeaders(responseHeaders),
        hasPostData: !!postData, headerCount: Object.keys(headers || {}).length,
      };
    });
    const next = offset + ids.length < this.requestOrder.length ? offset + ids.length : null;
    return { entries, cursor: offset, nextCursor: next, more: next !== null, total: this.requestOrder.length };
  }

  listRequests({ limit = 100 } = {}) {
    return this.listRequestsPage({ limit, cursor: Math.max(0, this.requestOrder.length - Math.max(1, Math.min(100, Number(limit) || 100))) }).entries;
  }

  async requestDetail(requestId) {
    this.assertOpen();
    const record = this.requests.get(String(requestId));
    if (!record) throw new Error('未找到该请求记录：' + requestId);
    let body = '';
    let base64Encoded = false;
    let bodyUnavailable = '';
    try {
      const result = await this.client.call('Network.getResponseBody', { requestId: String(requestId) });
      body = result.body || '';
      base64Encoded = result.base64Encoded === true;
    }
    catch (error) { bodyUnavailable = redactText(error?.message || error) || 'response-body-unavailable'; }
    const responseBody = base64Encoded ? '' : redactText(body).slice(0, 20000);
    const safe = {
      ...record,
      url: redactText(record.url),
      headers: redactHeaders(record.headers),
      responseHeaders: redactHeaders(record.responseHeaders),
      postData: redactText(record.postData),
      responseBody,
      responseBodyTruncated: body.length > 20000,
      capturedBytes: body.length,
      binary: base64Encoded,
      responseBodyEncoding: base64Encoded ? 'base64' : 'text',
      ...(base64Encoded ? { responseBodyBase64: body.slice(0, 20000) } : {}),
      ...(bodyUnavailable ? { bodyUnavailable } : {}),
    };
    return safe;
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
    try { this.guardAbort?.abort(new Error('浏览器会话已关闭')); } catch { /* 已关闭 */ }
    for (const release of this.pacingReleases.values()) { try { release(); } catch { /* 已释放 */ } }
    this.pacingReleases.clear();
    try { await this.clearRequestOverride(); } catch { /* 忽略 */ }
    try { this.client.close(); } catch { /* 已关闭 */ }
    try { this.child.kill(); } catch { /* 已退出 */ }
    await sleep(200);
  }
}

export async function startBrowserSession(options = {}) {
  return BrowserSession.start(options);
}
