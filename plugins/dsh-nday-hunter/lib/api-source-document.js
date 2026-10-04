// Preserve each complete parsed API record. This is serialized JSON, not a
// claim to retain HTTP envelope bytes or to prove applicability/exploitation.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const API_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;
export const OSV_DOCUMENT_MAX_BYTES = 32 * 1024 * 1024;
const formats = new Set(['nvd-cve-2.0', 'github-global-advisory', 'osv']);
export function attachApiDocument(candidate, document, format, home) {
  if (!formats.has(format)) throw new Error('Unknown API advisory document format');
  const id = format === 'github-global-advisory' ? document?.ghsa_id : document?.id;
  if (typeof id !== 'string' || !id || id !== candidate.id) throw new Error('API advisory identity differs from candidate');
  const bytes = Buffer.from(JSON.stringify(document), 'utf8');
  const maximum = format === 'osv' ? OSV_DOCUMENT_MAX_BYTES : API_DOCUMENT_MAX_BYTES;
  if (bytes.length > maximum) throw new Error(`API advisory document exceeds ${maximum / 1048576} MiB; page not committed`);
  const sha256 = digest(bytes);
  const advisory = { format, representation: 'serialized-api-json', sha256, totalBytes: bytes.length,
    conditionCount: (format === 'nvd-cve-2.0' ? document.configurations : format === 'osv' ? document.affected : document.vulnerabilities)?.length ?? 0,
    referenceCount: document.references?.length ?? 0, contentAvailable: false };
  if (home) {
    const parent = path.resolve(home, 'nday-hunter'), root = path.join(parent, 'source-content');
    fs.mkdirSync(root, { recursive: true });
    const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(root));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('API advisory cache is outside source storage');
    const file = path.join(root, sha256 + '.json');
    try { fs.writeFileSync(file, bytes, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const cached = fs.lstatSync(file);
      if (!cached.isFile() || cached.size !== bytes.length || digest(fs.readFileSync(file)) !== sha256)
        throw new Error('API advisory cached content digest differs');
    }
    advisory.contentFile = file; advisory.contentAvailable = true;
  }
  // Body text, upstream and related IDs describe other vulnerabilities. Only
  // the source's declared identity/aliases may participate in deduplication.
  const declared = format === 'github-global-advisory' ? [document.cve_id, document.ghsa_id]
    : [document.id, ...(format === 'osv' && Array.isArray(document.aliases) ? document.aliases : [])];
  const ids = [...new Set(declared.filter(value => typeof value === 'string' && value.length > 0 && value.length <= 160))];
  return { ...candidate, ids, identifierSemantics: 'declared-only', advisory };
}
