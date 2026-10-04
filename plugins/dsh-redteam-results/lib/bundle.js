import { outcomeSummary, renderFindingDelivery, renderReproduction } from './delivery.js';
import { renderCheckedTsv } from './checked.js';

// Remove common credential fields in shareable evidence. Originals remain local.
export function redactCredentials(value) {
  return String(value ?? '')
    .replace(/^(\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:).*$/gim, '$1 [REDACTED: supply your test identity]')
    .replace(/([?&](?:password|passwd|token|access_token|api_key|secret|session)\s*=)[^\s&#]*/gi, '$1[REDACTED]')
    .replace(/("(?:password|passwd|token|access_token|api_key|secret|cookie)"\s*:\s*")[^"\r\n]*(")/gi, '$1[REDACTED]$2')
    .replace(/((?:^|[&\n])(?:password|passwd|token|access_token|api_key|secret)\s*=)[^&\r\n]*/gi, '$1[REDACTED]');
}
export function assertNoLiteralCredentials(method) {
  if (method.kind !== 'script') return;
  const code = method.code + '\n' + method.runCommand;
  const assignments = [...code.matchAll(/\b(?:password|passwd|token|access_token|api_key|secret|cookie|authorization)["']?\s*[:=]\s*["']([^"'\r\n]+)["']/gi)];
  if (assignments.some(match => !/^(?:\$[\w{]|%[\w]+%$)/.test(match[1]))
    || /(?:cookie|authorization|x-api-key):\s*(?!["']?\$)[\w.-]+/i.test(code)
    || /(?:--password|--token|--api-key)\s+["']?[\w.-]+/i.test(code)
    || /https?:\/\/[^\s/:]+:[^\s/@]+@/i.test(code)) {
    throw new Error('reproduction contains a literal credential; replace it with an environment/parameter input before sharing');
  }
}
function scriptFilename(method) {
  const names = [...new Set([...method.runCommand.matchAll(/(?:^|\s|["'])(?:\.\/)?([\w.-]+\.(?:py|mjs|js|sh|ps1|txt))(?=["'\s]|$)/g)].map(match => match[1]))];
  const name = method.scriptFilename ?? (names.length === 1 ? names[0] : undefined);
  if (typeof name !== 'string' || !/^[\w.-]+$/.test(name) || name === '.' || name === '..'
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || !method.runCommand.includes(name)) {
    throw new Error('script needs a safe scriptFilename matching runCommand; save a single-file reproduction with its actual command');
  }
  return name;
}
export function buildDeliveryFiles(findings, checks) {
  const summary = outcomeSummary(findings);
  const files = { 'delivery/checked.tsv': renderCheckedTsv(checks) };
  const report = ['# 有效漏洞交付', '', summary.confirmedFindings ? `本包包含 ${summary.confirmedFindings} 条已复核的有效漏洞。` : '本轮未确认有效漏洞。',
    summary.incompleteRecords ? `另有 ${summary.incompleteRecords} 条记录材料或复核未齐，未计入本包有效成果；请在本地台账补齐。` : '',
    '检查覆盖见 checked.tsv；阴性仅适用于记录的入口、身份、方法与请求条件。',
    '证据中的常见认证头与凭据字段已脱敏。复现时通过参数或环境变量提供自己的测试身份。', ''];
  summary.outcomes.forEach(({ finding, state }, i) => {
    const stem = 'finding-' + (i + 1), method = state.method;
    assertNoLiteralCredentials(method);
    files[`delivery/repro/${stem}.md`] = (method.kind === 'script' ? `运行目录：repro/${stem}/（从该目录运行下列命令）\n\n` : '') + redactCredentials(renderReproduction(method));
    if (method.kind === 'script') files[`delivery/repro/${stem}/${scriptFilename(method)}`] = method.code;
    files[`delivery/evidence/${stem}-request.txt`] = redactCredentials(finding.requestPkt || '未保存原始请求；见成果证据引用。');
    files[`delivery/evidence/${stem}-response.txt`] = redactCredentials(finding.responsePkt || '未保存原始响应；见成果证据引用。');
    if (finding.executionEvidence?.effectEvidence) files[`delivery/evidence/${stem}-effect.json`] = JSON.stringify(finding.executionEvidence.effectEvidence, null, 2) + '\n';
    report.push(`复现材料：repro/${stem}.md；关键证据：evidence/${stem}-request.txt、evidence/${stem}-response.txt`, '', redactCredentials(renderFindingDelivery(finding)), '');
  });
  files['delivery/findings.md'] = report.filter(value => value !== '').join('\n\n') + '\n';
  return { files, confirmedFindings: summary.confirmedFindings, incompleteRecords: summary.incompleteRecords, checkedCount: checks.length };
}

const crcTable = Array.from({ length: 256 }, (_, i) => {
  let value = i;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
// Standard uncompressed ZIP: portable, dependency-free and directly extractable.
export function zipDelivery(files) {
  const entries = Object.entries(files);
  if (entries.length > 10000) throw new Error('delivery exceeds file limit');
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    if (!name.startsWith('delivery/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..') || /[\u0000-\u001f:]/.test(name)) throw new Error('unsafe archive path');
    const filename = Buffer.from(name, 'utf8'), data = Buffer.from(text, 'utf8'), crc = crc32(data);
    if (filename.length > 65535 || offset + data.length > 32 * 1024 * 1024) throw new Error('delivery exceeds 32MB size limit');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42); central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  if (offset + directory.length + end.length > 32 * 1024 * 1024) throw new Error('delivery exceeds 32MB size limit');
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
