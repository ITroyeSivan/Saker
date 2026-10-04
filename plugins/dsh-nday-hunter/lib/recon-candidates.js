// Recon narrows screening; these matches are product clues, never applicability
// or vulnerability verdicts. Generic stacks cannot select the entire catalog.
const GENERIC = new Set(['oa', 'erp', 'web', 'java', 'php', 'asp', 'http', 'https', 'nginx', 'apache',
  'rce', 'sql', 'sqli', 'cms', '系统', '应用', '服务器', '中间件', '国产', '信创'])
const normalized = value => String(value ?? '').trim().toLowerCase()
export function productTerms(entry) {
  return [...new Set([entry?.product, ...(entry?.aliases ?? [])].map(normalized)
    .filter(term => term.length >= 3 && !GENERIC.has(term)))]
}
function contains(text, term) {
  if (!/^[\x00-\x7f]+$/.test(term)) return text.includes(term)
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(text)
}
export function selectReconCandidates(entries, asset) {
  // Do not infer products from a chosen domain name, analyst tags or vendor name.
  const observations = [asset?.title, asset?.server, ...(Array.isArray(asset?.tech) ? asset.tech : []), asset?.observedText]
    .map(normalized).filter(Boolean)
  return entries.filter(entry => productTerms(entry).some(term => observations.some(text => contains(text, term))))
    .map(entry => ({ entryId: entry.id, terms: productTerms(entry).filter(term => observations.some(text => contains(text, term))) }))
}
export function reconObservation(asset, response) {
  const body = String(response.body || '')
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.replace(/\s+/g, ' ').trim() || ''
  const server = String(response.headers?.server || '')
  const surfaces = []
  for (const match of body.matchAll(/(?:href|src|action)\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const url = new URL(match[1], asset.base)
      if (url.origin === new URL(asset.base).origin && !url.username && !url.password
        && !surfaces.includes(url.href)) surfaces.push(url.href)
    } catch { /* invalid markup is not an observed endpoint */ }
    if (surfaces.length >= 20) break
  }
  const blocked = !response.ok ? 'transport-blocked' : [401, 403, 429].includes(response.status) ? 'access-blocked'
    : response.redirect?.followed === false ? 'redirect-boundary'
      : /<input\b[^>]*type\s*=\s*["']?password\b/i.test(body) ? 'authentication-required' : ''
  return { ...asset, title, server, observedText: blocked ? '' : body, blocked,
    surfaces, inputObserved: /<(?:input|textarea|select)\b/i.test(body),
    nextAction: blocked ? 'resolve-access-or-transport' : surfaces.length || /<(?:input|textarea|select)\b/i.test(body)
      ? 'observe-valid-input-and-auth-context' : 'record-product-and-component-gap' }
}
