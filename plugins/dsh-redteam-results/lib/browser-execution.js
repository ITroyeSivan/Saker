// 浏览器执行（v6 第 9.1 节）：当前 origin、实际浏览器行为、输入到 DOM/页面路径、相关防护。
//
// 只有**宿主真的开了一个浏览器**才算证据：本模块用本机 Chrome/Edge 的无头模式 + CDP 打开复核过的
// HTTP(S) URL，等页面加载完，再在页面里求值 `window.__sakerProbe`——载荷必须是被执行过才会把它
// 设成复核 marker。仅回显文本、被转义、被 CSP 拦下都不会让这个值出现；本地 file: 环境直接拒绝。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCftExecutable } from './browser-session.js';

export const BROWSER_RECEIPT_SCHEMA = `CREATE TABLE IF NOT EXISTS browser_receipts (
 session_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(session_id,id)
);`;

const PROBE_VARIABLE = 'window.__sakerProbe';

/** 与项目浏览器统一使用独立的 Chrome for Testing。 */
export function findBrowserExecutable(explicit) {
  return resolveCftExecutable(explicit || process.env.SAKER_BROWSER_PATH);
}

function waitForDevtoolsUrl(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('浏览器启动超时（未拿到 DevTools 地址）')), timeoutMs);
    const onData = chunk => {
      buffer += chunk.toString();
      const match = /ws:\/\/[^\s]+/.exec(buffer);
      if (match) { clearTimeout(timer); child.stderr.off('data', onData); resolve(match[0]); }
    };
    child.stderr.on('data', onData);
    child.on('exit', code => { clearTimeout(timer); reject(new Error('浏览器进程提前退出（code=' + code + '）')); });
  });
}

async function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); }
    else if (message.method) events.push(message);
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })); });
  return { call, events, close: () => ws.close() };
}

/**
 * 打开真实浏览器跑一次复核过的 URL，记录：真实 origin、载荷是否真的执行、CSP/对话框等防护现象。
 * 不写文件、不点页面元素、不发额外请求——只导航 + 读一个变量。
 */
export async function runBrowserExecution({ url, marker, timeoutMs = 15000, executablePath, probeVariable = PROBE_VARIABLE } = {}) {
  if (typeof url !== 'string' || !url) throw new Error('复核过的 URL 必填');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('URL 格式无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只接受真实 HTTP(S) origin；本地 file 环境不算浏览器执行');
  if (typeof marker !== 'string' || !/^[A-Za-z0-9_-]{6,200}$/.test(marker)) throw new Error('复核 marker 必填（6-200 位字母数字）');
  if (probeVariable !== PROBE_VARIABLE) throw new Error('探测变量固定为 window.__sakerProbe');
  const executable = findBrowserExecutable(executablePath);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-browser-'));
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const child = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let client = null;
  try {
    const wsUrl = await waitForDevtoolsUrl(child, Math.min(timeoutMs, 15000));
    const base = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
    const target = await (await fetch(base + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })).json();
    client = await cdpClient(target.webSocketDebuggerUrl);
    await client.call('Runtime.enable').catch(() => {});
    await client.call('Log.enable').catch(() => {});
    await client.call('Page.enable').catch(() => {});
    await client.call('Page.navigate', { url }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, Math.min(2500, timeoutMs)));
    const origin = await client.call('Runtime.evaluate', { expression: 'location.origin', returnByValue: true });
    const probe = await client.call('Runtime.evaluate', { expression: probeVariable, returnByValue: true });
    const cspViolations = client.events.filter(event => event.method === 'Log.entryAdded' && /content security policy|csp/i.test(String(event.params?.entry?.text || ''))).length;
    const dialogs = client.events.filter(event => event.method === 'Page.javascriptDialogOpening').length;
    const probeValue = typeof probe.result?.value === 'string' ? probe.result.value.slice(0, 200) : null;
    return { source: 'host-browser-execution', engine: path.basename(executable), url, origin: String(origin.result?.value || ''),
      marker, probeVariable, probeValue, executed: probeValue === marker, cspViolations, dialogs,
      startedAt, completedAt: new Date().toISOString(), elapsedMs: Date.now() - started,
      evidenceLimit: '真实浏览器在当前 origin 与当前防护下的执行现象；不等于权限、持久化或 RCE，也不代表其他浏览器/上下文同样成立。' };
  } finally {
    try { client?.close(); } catch { /* 已关闭 */ }
    try { child.kill(); } catch { /* 已退出 */ }
    // Windows 上浏览器退出后仍会短暂占用 profile 目录，等一下再删。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 }); break; }
      catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); }
    }
  }
}

export function recordBrowserReceipt(store, sessionId, receipt) {
  if (!receipt || receipt.source !== 'host-browser-execution') throw new Error('host browser receipt required');
  const record = { id: 'browser-' + randomUUID(), ...receipt };
  store.db.prepare('INSERT INTO browser_receipts (session_id,id,record) VALUES (?,?,?)').run(sessionId, record.id, JSON.stringify(record));
  return record;
}

export function readBrowserReceipt(store, sessionId, id) {
  const row = store.db.prepare('SELECT record FROM browser_receipts WHERE session_id=? AND id=?').get(sessionId, String(id || ''));
  if (!row) throw new Error('browser receipt not found in current session');
  return JSON.parse(row.record);
}
