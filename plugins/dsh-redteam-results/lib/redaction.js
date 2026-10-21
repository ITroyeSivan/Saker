const SECRET_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|session|sessionid)$/i;
const SECRET_KEY_EMBEDDED = /(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|session|cookie|authorization)/i;

export function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[name] = SECRET_KEY.test(String(name).trim()) ? '[已遮蔽]' : redactText(Array.isArray(value) ? value.join(', ') : value);
  }
  return out;
}

export function redactText(value) {
  return String(value ?? '')
    .replace(/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token):[^\r\n]*/gim,
      line => line.split(':')[0] + ': [已遮蔽]')
    .replace(/([?&](?:password|passwd|pwd|token|access_token|refresh_token|api_key|secret|session|signature)=)[^&#\s"'`]*/gi,
      '$1[已遮蔽]')
    .replace(/(["']?(?:password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|session|cookie|authorization)["']?\s*[:=]\s*)(["']?)([^"'\r\n,}\s]+)\2/gi,
      (_match, head, quote) => head + quote + '[已遮蔽]' + quote)
    .replace(/((?:^|[&\n])(?:password|passwd|pwd|token|access_token|refresh_token|api_key|secret|session|signature)\s*=)[^&\r\n]*/gi,
      '$1[已遮蔽]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已遮蔽]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[已遮蔽:私钥]');
}

export function redactValue(value, key = '') {
  if (key && SECRET_KEY_EMBEDDED.test(String(key))) return '[已遮蔽]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(item => redactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(item, name)]));
  }
  return value;
}

export function redactError(error) {
  return redactText(error?.message || error || '未知错误');
}
