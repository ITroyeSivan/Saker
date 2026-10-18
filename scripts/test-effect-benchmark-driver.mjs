import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHANNEL, callChannel, login } from './effect-benchmark-driver.mjs';

let failed = 0;
async function test(label, fn) { try { await fn(); console.log('ok ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }

// 桩服务器按宿主 rpc-host.ts 的规则实现：POST + application/json + method===endpoint + 会话 cookie。
const seen = [];
let drift = false;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/') {
    if (url.searchParams.get('token') !== 'good-token') { res.writeHead(403); res.end('bad token'); return }
    res.writeHead(302, { 'set-cookie': 'sid=stub-session; Path=/' }); res.end(); return
  }
  const endpoint = url.pathname.startsWith(CHANNEL + '/') ? url.pathname.slice(CHANNEL.length + 1) : undefined;
  if (req.method !== 'POST' || endpoint === undefined) { res.writeHead(404); res.end('not found'); return }
  const media = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (media !== 'application/json') { res.writeHead(415); res.end('content type must be application/json'); return }
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { res.writeHead(400); res.end('body is not JSON'); return }
    seen.push({ endpoint, body, cookie: req.headers.cookie ?? '' });
    const reply = (payload, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) };
    if (body?.type !== 'client-request' || typeof body.rpcId !== 'string') { res.writeHead(400); res.end('invalid envelope'); return }
    if (endpoint === 'unauthenticated') { res.writeHead(401); res.end('unauthorized'); return }
    if (!req.headers.cookie) { res.writeHead(401); res.end('unauthorized'); return }
    if (body.method !== endpoint) {
      reply({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: { code: 'gateway/bad-request', message: `method ${body.method} does not match endpoint ${endpoint}`, details: {} } } });
      return
    }
    if (endpoint === 'boom') { res.writeHead(500); res.end('handler failure: boom'); return }
    if (endpoint === 'string-error') {
      reply({ type: 'server-response', rpcId: body.rpcId, result: { ok: false, error: 'frozen baseline version is not installed' } });
      return
    }
    reply({ type: 'server-response', rpcId: drift ? 'mismatched-rpc-id' : body.rpcId,
      result: { ok: true, value: { endpoint, payload: body.payload ?? null } } });
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  await test('login turns the launch token into a session cookie', async () => {
    const cookie = await login({ base, token: 'good-token' });
    assert.equal(cookie, 'sid=stub-session');
    await assert.rejects(login({ base, token: 'bad-token' }), /no session cookie/);
    await assert.rejects(login({ base, token: '' }), /launch token is required/);
  });

  await test('the channel endpoint gets the plugin payload unwrapped and answers the value', async () => {
    const cookie = await login({ base, token: 'good-token' });
    const value = await callChannel({ base, cookie, endpoint: 'inventory', payload: { probe: 7 } });
    assert.equal(value.endpoint, 'inventory');
    assert.deepEqual(value.payload, { probe: 7 }, 'payload must reach the handler as-is, not wrapped in { args }');
    const last = seen.at(-1);
    assert.equal(last.body.type, 'client-request');
    assert.equal(last.body.method, 'inventory');
    assert.ok(last.cookie.includes('sid=stub-session'), 'the session cookie must be carried');
    assert.equal(typeof last.body.rpcId, 'string');
  });

  await test('an endpoint with no payload still works', async () => {
    const cookie = await login({ base, token: 'good-token' });
    const value = await callChannel({ base, cookie, endpoint: 'inventory' });
    assert.deepEqual(value.payload, {});
  });

  await test('a gateway error surfaces code and message instead of a silent undefined', async () => {
    const cookie = await login({ base, token: 'good-token' });
    await assert.rejects(
      callChannel({ base, cookie, endpoint: 'inventory', channel: CHANNEL, fetchImpl: (url, init) =>
        fetch(url, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), method: 'wrong-endpoint' }) }) }),
      /gateway\/bad-request/);
  });

  await test('a plain string error from the endpoint is shown verbatim, not as unknown', async () => {
    const cookie = await login({ base, token: 'good-token' });
    await assert.rejects(callChannel({ base, cookie, endpoint: 'string-error' }), /channel error: frozen baseline version is not installed/);
    await assert.rejects(callChannel({ base, cookie, endpoint: 'string-error' }), error => !/unknown/.test(error.message));
  });

  await test('HTTP failures and wrong envelopes are reported, not swallowed', async () => {
    const cookie = await login({ base, token: 'good-token' });
    await assert.rejects(callChannel({ base, cookie, endpoint: 'boom' }), /HTTP 500/);
    await assert.rejects(callChannel({ base, cookie, endpoint: 'unauthenticated' }), /HTTP 401/);
    await assert.rejects(callChannel({ base, cookie: '', endpoint: 'inventory' }), /HTTP 401/);
    await assert.rejects(callChannel({ base, cookie, endpoint: 'inventory', fetchImpl: async () => new Response('nope', { status: 200 }) }), /not JSON/);
    await assert.rejects(callChannel({ base, cookie, endpoint: 'inventory', fetchImpl: async () => Response.json({ type: 'other' }) }), /unexpected envelope/);
  });

  await test('a mismatched rpcId is treated as protocol drift', async () => {
    const cookie = await login({ base, token: 'good-token' });
    drift = true;
    try { await assert.rejects(callChannel({ base, cookie, endpoint: 'inventory' }), /rpcId mismatch/); }
    finally { drift = false; }
  });
} finally {
  await new Promise(resolve => server.close(resolve));
}

// CLI 入口单独验一次：直接运行时必须真的执行请求，而不是静默什么都不做
// （`import.meta.url === 'file://' + argv[1]` 这种写法在 Windows 上永远不成立，踩过）。
await test('the CLI entry actually runs and reports a failure with a non-zero exit code', () => {
  const cli = fileURLToPath(new URL('./effect-benchmark-driver.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--base', 'http://127.0.0.1:1', '--token', 'x', 'inventory'],
    { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.notEqual(result.status, 0, 'a dead host must not exit 0');
  assert.match(result.stderr, /FAILED:/);
  assert.equal(result.stdout.trim(), '');
});

await test('the CLI refuses to run without a base URL or action', () => {
  const cli = fileURLToPath(new URL('./effect-benchmark-driver.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

console.log('Fixture verification only: a loopback stub host, no real dsh host and no model call.');
process.exitCode = failed ? 1 : 0;
