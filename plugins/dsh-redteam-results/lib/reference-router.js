import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { boundedJson, queryConcepts } from './knowledge-retrieval.js';

const webCache = new Map();
const CACHE_LIMIT = 24;
const WEB_REF_SECRET = randomBytes(32);
const now = () => Date.now();
function sha(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function encode(value) { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'); }
function decode(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}
function domainOf(value) {
  try { return new URL(value).hostname; } catch { return '网页'; }
}
function signatureFor(decoded) {
  const body = { ...decoded };
  delete body.sig;
  return createHmac('sha256', WEB_REF_SECRET).update(JSON.stringify(body)).digest('hex');
}
function signWebRef(decoded) { return { ...decoded, sig: signatureFor(decoded) }; }
export function verifyWebRef(ref, authorization = {}) {
  const decoded = decodeWebRef(ref);
  if (!decoded || !decoded.sig) throw Object.assign(new Error('web reference is not authorized'), { code: 'ref_forbidden' });
  const expected = Buffer.from(signatureFor(decoded), 'hex');
  const actual = Buffer.from(String(decoded.sig), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw Object.assign(new Error('web reference signature invalid'), { code: 'ref_forbidden' });
  const projectKey = String(authorization.projectKey || '');
  if (projectKey && decoded.projectKey !== projectKey)
    throw Object.assign(new Error('web reference belongs to another project'), { code: 'ref_forbidden' });
  if (authorization.strategy && decoded.strategy !== authorization.strategy)
    throw Object.assign(new Error('web reference does not belong to the current strategy'), { code: 'ref_forbidden' });
  return decoded;
}
function normalizedWebRows(result, query, authorization = {}) {
  const rows = [];
  const queryHash = sha(query).slice(0, 16);
  for (const source of Array.isArray(result?.sources) ? result.sources : []) {
    let url;
    try { url = new URL(source.url); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    const ref = 'web:' + encode(signWebRef({ url: url.href, queryHash, projectKey: String(authorization.projectKey || ''),
      strategy: String(authorization.strategy || 'web-first'), at: now() }));
    rows.push({
      ref, title: String(source.title || url.hostname).slice(0, 180),
      section: '搜索摘要', excerpt: String(source.snippet || source.title || '').slice(0, 620),
      sourceKind: 'web', sourceLabel: domainOf(url.href), revision: sha(source.snippet || url.href).slice(0, 16),
      product: null, version: null, applicability: 'unknown',
      sourceDate: source.publishedAt || null, stale: 'unknown',
    });
  }
  return rows;
}
function dedupe(rows) {
  const out = [], seen = new Set();
  for (const row of rows) {
    const key = String(row.ref || '') + '\0' + String(row.title || '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
async function boundedCall(work, signal, milliseconds) {
  const controller = new AbortController();
  const combined = signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const abortedError = signal?.reason instanceof Error ? signal.reason
    : Object.assign(new Error('reference query cancelled'), { code: 'cancelled' });
  if (signal?.aborted) throw abortedError;
  let timer, onAbort;
  try {
    return await new Promise((resolve, reject) => {
      const fail = error => { controller.abort(error); reject(error); };
      onAbort = () => fail(abortedError);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => fail(Object.assign(new Error('reference query timed out'), { code: 'timeout' })), milliseconds);
      Promise.resolve().then(() => {
        if (signal?.aborted) throw abortedError;
        return work(combined);
      }).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
function webUnavailable(error) {
  return { ok: false, status: 'error', code: /abort/i.test(String(error?.name)) ? 'cancelled' : 'web_unavailable',
    error: String(error?.message || error || 'web unavailable') };
}
async function webSearch(adapters, query, limit, signal, authorization) {
  if (typeof adapters.webSearch !== 'function') return webUnavailable(new Error('web search service unavailable'));
  try {
    const result = await boundedCall(active => adapters.webSearch({ query, maxResults: limit }, active), signal, 10000);
    const rows = normalizedWebRows(result, query, authorization);
    return { ok: true, status: rows.length ? 'hits' : 'no_match', rows, truncated: result?.truncated === true };
  } catch (error) { return webUnavailable(error); }
}
async function localSearch(adapters, query, input, signal) {
  if (typeof adapters.localSearch !== 'function') return { ok: false, status: 'error', code: 'index_unavailable',
    error: 'local knowledge index unavailable' };
  try {
    return await boundedCall(active => adapters.localSearch({
      query, limit: input.limit ?? 5, cursor: input.cursor,
      product: input.product, version: input.version,
    }, active), signal, 2000);
  } catch (error) {
    return { ok: false, status: 'error', code: 'index_unavailable', error: String(error?.message || error) };
  }
}

/**
 * One deterministic reference search. The first source follows the selected
 * strategy; the other source is consulted at most once, and never in
 * knowledge-only mode. `fallbackReason` supports a model's explicit "these
 * hits are not applicable" follow-up without introducing query rewriting.
 */
export async function runReferenceSearch(adapters, input = {}, signal) {
  const strategy = ['web-first', 'knowledge-first', 'knowledge-only'].includes(input.strategy)
    ? input.strategy : 'web-first';
  const query = String(input.query || '').trim();
  const authorization = { projectKey: String(input.projectKey || input.scope?.projectKey || ''), strategy };
  const concepts = queryConcepts(query);
  const limit = Math.max(1, Math.min(5, Number(input.limit) || 5));
  let first;
  let second;
  let secondKind = '';
  if (strategy === 'knowledge-only') {
    first = await localSearch(adapters, query, { ...input, limit }, signal);
    return finalize(query, strategy, first, null, secondKind, concepts);
  }
  if (strategy === 'web-first') {
    const web = await webSearch(adapters, query, limit, signal, authorization);
    if (!input.fallbackReason && web.ok && (web.rows || []).length) return finalize(query, strategy, web, null, '', concepts);
    first = web;
    if (signal?.aborted) return finalize(query, strategy, { ok: false, status: 'error', code: 'cancelled', error: 'query cancelled' }, null, '', concepts);
    second = await localSearch(adapters, query, { ...input, limit }, signal);
    secondKind = 'local';
    return finalize(query, strategy, second, first, secondKind, concepts,
      web.ok ? '没有可用网页候选' : '联网搜索不可用');
  }
  const local = await localSearch(adapters, query, { ...input, limit }, signal);
  if (!input.fallbackReason && local.ok && (local.rows || []).length) return finalize(query, strategy, local, null, '', concepts);
  first = local;
  if (signal?.aborted) return finalize(query, strategy, { ok: false, status: 'error', code: 'cancelled', error: 'query cancelled' }, null, '', concepts);
  second = await webSearch(adapters, query, limit, signal, authorization);
  secondKind = 'web';
  return finalize(query, strategy, second, first, secondKind, concepts,
    local.ok ? '本地没有可用候选' : '本地索引不可用');
}
function finalize(query, strategy, primary, fallback, secondKind, concepts, fallbackReason = '') {
  const rows = dedupe([...(primary?.rows || []), ...(fallback?.rows || [])]).slice(0, 5);
  const status = rows.length ? 'hits' : (primary?.status === 'error' ? 'error' : 'no_match');
  const payload = boundedJson({
    ok: primary?.ok !== false || rows.length > 0,
    status, query, strategy,
    rows,
    nextCursor: primary?.nextCursor || null,
    fallbackUsed: !!fallbackReason,
    fallbackReason: fallbackReason || null,
    fallbackAvailable: strategy !== 'knowledge-only',
    source: rows.some(row => row.sourceKind === 'web') ? 'web+local' : rows.some(row => row.sourceKind === 'local') ? 'local' : 'none',
    ...(primary?.code ? { code: primary.code } : {}),
    ...(primary?.error ? { error: primary.error } : {}),
    ...(primary?.indexRevision ? { indexRevision: primary.indexRevision } : {}),
    ...(primary?.workerSearch ? { workerSearch: true } : {}),
    ...(primary?.workerFallback ? { workerFallback: true, workerError: primary.workerError || '' } : {}),
    note: '结果只用于定位；读取正文按来源和字节上限分页。',
  }, 3072);
  return payload;
}

export function decodeWebRef(ref) {
  const value = String(ref || '');
  if (!value.startsWith('web:')) return null;
  const decoded = decode(value.slice(4));
  if (!decoded) return null;
  try {
    const url = new URL(decoded.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return decoded;
  } catch { return null; }
}
export async function readWebReference(ref, input = {}, adapters, signal) {
  const decoded = decodeWebRef(ref);
  if (!decoded) throw Object.assign(new Error('web reference invalid'), { code: 'ref_invalid' });
  if (input.requireAuthorized === true) verifyWebRef(ref, { projectKey: input.projectKey, strategy: input.strategy });
  if (typeof adapters.webFetch !== 'function') throw Object.assign(new Error('web fetch service unavailable'), { code: 'web_unavailable' });
  let cached = webCache.get(decoded.url);
  if (!cached || now() - cached.at > 5 * 60 * 1000) {
    const result = await boundedCall(active => adapters.webFetch({ url: decoded.url }, active), signal, 10000);
    const body = String(result?.body?.content ?? '');
    cached = { at: now(), body, statusCode: result?.statusCode ?? null, kind: result?.body?.kind || 'text',
      truncated: result?.truncated === true, digest: sha(body) };
    webCache.set(decoded.url, cached);
    while (webCache.size > CACHE_LIMIT) webCache.delete(webCache.keys().next().value);
  }
  const cursor = input.cursor ? decode(input.cursor) : null;
  if (input.cursor && (!cursor || cursor.url !== decoded.url || cursor.digest !== cached.digest))
    throw Object.assign(new Error('web read cursor expired'), { code: 'cursor_expired' });
  const offset = Math.max(0, Number(cursor?.offset) || 0);
  const maximum = Math.max(1, Math.min(8192, Number(input.maxBytes) || 8192));
  const bytes = Buffer.from(cached.body, 'utf8');
  if (offset > bytes.length) throw new Error('web read cursor out of range');
  let end = Math.min(bytes.length, offset + maximum);
  while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  const text = bytes.subarray(offset, end).toString('utf8');
  return {
    ok: true, status: 'read', ref: String(ref), title: null, section: '网页正文',
    text, sourceKind: 'web', sourceLabel: domainOf(decoded.url), revision: cached.digest.slice(0, 16),
    offset, bytes: end - offset, complete: end >= bytes.length,
    nextCursor: end < bytes.length ? encode({ url: decoded.url, digest: cached.digest, offset: end }) : null,
    statusCode: cached.statusCode, contentType: cached.kind,
    note: cached.truncated ? '宿主抓取结果已截断；不能把当前页当完整原文。' : null,
  };
}
export function clearReferenceCache() { webCache.clear(); }
