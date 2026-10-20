// Persisted views need a validated header, not an activated model session.
// A cold observation owns a lease: copy only metadata and always release it.
const failure = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });
function service(ctx, name) {
  try { return ctx[name] || ctx.get?.(name); } catch { return undefined; }
}
function pentest(session) {
  if (session.header?.agentPreset !== 'pentest')
    throw failure('session-preset-mismatch', '该会话不是渗透测试会话');
  return session;
}

export async function readPentestSession(ctx, sessionId) {
  if (!sessionId) throw failure('session-id-required', '请选择要查看的会话');
  const live = service(ctx, 'sessions')?.get(sessionId);
  if (live) return pentest(live);
  const query = service(ctx, 'sessionQuery');
  if (typeof query?.observeSession !== 'function')
    throw failure('session-read-unavailable', '会话读取服务尚未就绪，请重试');
  let observation;
  try {
    observation = await query.observeSession(sessionId, { projectionMode: 'none', signal: AbortSignal.timeout(10000) });
    if (!observation?.header || typeof observation[Symbol.dispose] !== 'function')
      throw failure('session-read-unavailable', '宿主未返回有效的会话读取结果，请重试');
    return pentest({ id: sessionId, header: { ...observation.header } });
  } catch (error) {
    if (error.code === 'SESSION_QUERY_SESSION_NOT_FOUND')
      throw failure('session-not-found', '未找到该会话，请重新选择', error);
    if (error.code === 'SESSION_QUERY_CORRUPT_SESSION')
      throw failure('session-read-corrupt', '会话记录无法读取，请保留记录并检查宿主错误', error);
    if (error.code === 'SESSION_QUERY_ABORTED' || error.name === 'TimeoutError' || error.name === 'AbortError')
      throw failure('session-read-timeout', '读取会话超时，请重试', error);
    throw error;
  } finally {
    if (typeof observation?.[Symbol.dispose] === 'function') observation[Symbol.dispose]();
  }
}
