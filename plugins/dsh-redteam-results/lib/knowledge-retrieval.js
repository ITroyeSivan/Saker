const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const CVE = /\bCVE-\d{4}-\d{4,7}\b/gi;
const PATH = /(?:^|\s)(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{2,})/g;
const LATIN = /[a-z0-9][a-z0-9_.:@+-]{1,}/gi;
const EN_STOP = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for',
  'from', 'how', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'the', 'to',
  'this', 'that', 'these', 'those', 'what', 'when', 'where', 'which', 'who',
  'why', 'with', 'use', 'used', 'using', 'via', 'get', 'set', 'one', 'two',
]);
const HAN_STOP = new Set([
  '如何', '怎么', '怎样', '什么', '哪些', '哪个', '是否', '可以', '需要',
  '进行', '使用', '一个', '这个', '那个', '以及', '相关', '我们', '你们',
  '他们', '请问', '一下', '怎样', '有何', '多少', '时候', '其中', '对于',
]);
const HAN_SYNONYMS = new Map(Object.entries({
  '漏洞': ['vulnerability', 'vulnerabilities', 'cve'],
  '影响': ['impact', 'affect', 'affected'],
  '版本': ['version', 'versions'],
  '修复': ['fix', 'patch', 'remediation'],
  '补丁': ['patch'],
  '提权': ['privilege escalation', 'privesc'],
  '权限': ['permission', 'privilege'],
  '鉴权': ['authentication', 'authorization', 'auth'],
  '认证': ['authentication', 'auth'],
  '绕过': ['bypass'],
  '检测': ['detect', 'detection'],
  '分析': ['analysis', 'analyze'],
  '生成': ['generate', 'generation'],
  '镜像': ['image', 'container image'],
  '供应链': ['supply chain'],
  '文件': ['file'],
  '上传': ['upload'],
  '审计': ['audit'],
  '扫描': ['scan'],
  '入口': ['entry', 'entrypoint', 'injection point'],
  '路径': ['path'],
  '权限矩阵': ['permission matrix', 'role matrix', 'rbac'],
  '利用': ['exploit', 'exploitation'],
  '消息': ['message'],
  '密钥': ['key', 'machinekey'],
  '签名': ['signature'],
  '反编译': ['decompile'],
  '保存': ['save', 'write'],
  '可读': ['readable'],
  '条件': ['condition', 'criteria'],
  '判据': ['criteria', 'indicator'],
  '数据': ['data'],
  '服务': ['service'],
  '账户': ['account'],
  '容器': ['container'],
  '逃逸': ['escape', 'breakout'],
  '注入': ['injection'],
  '反序列化': ['deserialization'],
  '序列化': ['serialization'],
  '内存': ['memory'],
  '取证': ['forensics'],
  '持久化': ['persistence'],
  '日志': ['log', 'logging'],
  '命令': ['command'],
  '执行': ['execute', 'execution'],
}));
const EN_ALIASES = new Map(Object.entries({
  'k8s': ['kubernetes'],
  'kubernetes': ['k8s'],
  'log4j2': ['log4j 2', 'log4j'],
  'log4shell': ['log4j', 'cve-2021-44228'],
  'privesc': ['privilege escalation', '提权'],
  'privilege': ['提权', 'permission'],
  'escalation': ['提权'],
  'upload': ['上传'],
  'file': ['文件'],
  'audit': ['审计'],
  'scan': ['扫描'],
  'path': ['路径'],
  'authentication': ['鉴权', '认证'],
  'authorization': ['鉴权', '授权'],
  'bypass': ['绕过'],
  'version': ['版本'],
  'versions': ['版本'],
  'patch': ['补丁', '修复'],
  'vulnerability': ['漏洞'],
  'impact': ['影响'],
  'detection': ['检测'],
  'analysis': ['分析'],
  'supply': ['供应链'],
  'chain': ['链'],
  'container': ['容器'],
  'image': ['镜像'],
  'deserialization': ['反序列化'],
  'machinekey': ['密钥'],
  'criteria': ['判据', '条件'],
  'condition': ['条件'],
  'conditions': ['条件'],
  'execution': ['执行'],
  'false': ['误报'],
  'positive': ['误报'],
  'viewstate': ['视图状态'],
  'gadget': ['利用链'],
}));

export function normalizeKnowledgeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
}
export function normalizedSearchText(value) {
  return normalizeKnowledgeText(value).toLowerCase().replace(/\s+/g, ' ').trim();
}
export function knowledgeTokens(value) {
  const text = normalizedSearchText(value);
  const tokens = [];
  for (const run of text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) || []) {
    if (run.length === 1) tokens.push(run);
    else for (let index = 0; index < run.length - 1; index += 1) tokens.push(run.slice(index, index + 2));
  }
  for (const token of text.match(LATIN) || []) tokens.push(token);
  return [...new Set(tokens)].slice(0, 96);
}

/**
 * Query concepts are ANDed across groups and ORed within one group. A Chinese
 * phrase remains one group (with its bigrams as a loose variant); the old
 * implementation incorrectly required every bigram of a sentence.
 */
export function queryConcepts(query) {
  const raw = normalizeKnowledgeText(query).trim();
  if (!raw) throw new Error('搜索需要关键词');
  if (raw.length > 512) throw new Error('搜索词最多 512 个字符');
  const groups = [];
  const add = (variants, kind) => {
    const unique = [...new Set(variants.map(normalizedSearchText).filter(Boolean))];
    if (unique.length) groups.push({ kind, variants: unique });
  };
  const cves = [...raw.matchAll(CVE)].map(match => match[0].toUpperCase());
  for (const cve of cves) add([cve], 'cve');
  const remaining = raw.replace(CVE, ' ');
  for (const match of remaining.matchAll(PATH)) add([match[1].toLowerCase()], 'path');
  const withoutPaths = remaining.replace(PATH, ' ');
  for (const run of withoutPaths.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) || []) {
    const normalized = normalizedSearchText(run);
    if (normalized.length <= 2) {
      if (!HAN_STOP.has(normalized)) add([normalized], 'han');
    }
    else {
      // Chinese does not use spaces. Keep each two-character term as its own
      // concept so a natural-language query can still match a section that
      // contains only part of the sentence. The complete phrase remains a
      // ranking bonus in scoreKnowledgeSection rather than a recall gate.
      for (let index = 0; index < normalized.length - 1; index += 1) {
        const bigram = normalized.slice(index, index + 2);
        if (!HAN_STOP.has(bigram)) add([bigram, ...(HAN_SYNONYMS.get(bigram) || [])], 'han');
      }
    }
  }
  for (const token of withoutPaths.match(LATIN) || []) {
    const normalized = token.toLowerCase();
    if (normalized.length >= 2 && !EN_STOP.has(normalized) && !cves.includes(normalized.toUpperCase()))
      add([normalized, ...(EN_ALIASES.get(normalized) || [])], 'latin');
  }
  const deduped = [];
  const seen = new Set();
  for (const group of groups) {
    const key = group.kind + ':' + group.variants[0];
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(group);
  }
  if (!deduped.length) add([raw], 'literal');
  if (deduped.length > 24) throw new Error('搜索概念过多，请缩小到 24 个主要概念以内');
  return {
    raw,
    phrase: normalizedSearchText(raw),
    conceptual: deduped,
    cves,
    paths: [...new Set(deduped.filter(group => group.kind === 'path').flatMap(group => group.variants))],
  };
}

export function conceptMatches(concept, haystack) {
  return concept.variants.some(variant => haystack.includes(variant));
}
export function matchCoverage(concepts, haystack) {
  if (!concepts.length) return 0;
  return concepts.filter(concept => conceptMatches(concept, haystack)).length / concepts.length;
}
export function ftsExpression(concepts) {
  const tokens = knowledgeTokens(concepts.map(concept => concept.variants.join(' ')).join(' '));
  return tokens.map(token => '"' + token.replace(/"/g, '""') + '"').join(' OR ');
}

function parseVersion(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.[xX*])?$/u.exec(String(value || '').trim());
  if (!match) return null;
  return [Number(match[1]), match[2] === undefined ? null : Number(match[2]), match[3] === undefined ? null : Number(match[3])];
}
export function versionApplicability(documentVersion, requestedVersion) {
  if (!requestedVersion) return 'unknown';
  if (!documentVersion) return 'unknown';
  const wanted = parseVersion(requestedVersion);
  const actual = parseVersion(documentVersion);
  if (!wanted || !actual) return normalizedSearchText(documentVersion) === normalizedSearchText(requestedVersion) ? 'exact' : 'unknown';
  for (let index = 0; index < 3; index += 1) {
    if (wanted[index] === null) break;
    if (actual[index] === null) return 'unknown';
    if (actual[index] !== wanted[index]) return 'excluded';
  }
  return 'exact';
}

export function scoreKnowledgeSection(row, concepts, constraints = {}) {
  const title = normalizedSearchText(row.title);
  const heading = normalizedSearchText(row.heading);
  const path = normalizedSearchText(row.path);
  const body = normalizedSearchText(row.text);
  const haystack = [title, heading, path, body].join('\n');
  if (constraints.cves?.length && !constraints.cves.every(cve => haystack.includes(cve.toLowerCase()))) return null;
  if (constraints.paths?.length && !constraints.paths.every(value => haystack.includes(value))) return null;
  if (constraints.product && row.product && normalizedSearchText(row.product) !== normalizedSearchText(constraints.product)) return null;
  const version = versionApplicability(row.version, constraints.version);
  if (version === 'excluded') return null;
  const matchedConcepts = concepts.filter(concept => conceptMatches(concept, haystack));
  const coverage = concepts.length ? matchedConcepts.length / concepts.length : 0;
  const exactConcepts = concepts.filter(concept => ['cve', 'path'].includes(concept.kind));
  const exact = exactConcepts.length > 0
    && exactConcepts.every(concept => conceptMatches(concept, haystack));
  // Short exact phrases still require every meaningful term. Longer natural
  // questions are allowed to match a relevant section partially; otherwise a
  // question such as "which patch fixes the JNDI lookup" misses a section that
  // contains all the important facts but not every English connective.
  const required = constraints.requireAll === true
    ? 1
    : concepts.length <= 2 ? 1 : concepts.length <= 4 ? 0.5 : 0.4;
  const headingMatched = matchedConcepts.filter(concept => conceptMatches(concept, heading)).length;
  // A section heading is a strong relevance signal. Let two heading concepts
  // carry a longer natural-language question even when the user's paraphrase
  // does not repeat every connective from the document.
  if (coverage < required && headingMatched < 2) return null;
  if (concepts.length >= 4 && matchedConcepts.length < 2) return null;
  if (exactConcepts.length && !exact) return null;
  const titleHits = matchedConcepts.filter(concept => conceptMatches(concept, title)).length;
  const headingHits = headingMatched;
  const phraseHit = constraints.phrase && haystack.includes(constraints.phrase) ? 1 : 0;
  const applicability = version === 'exact' ? 1 : version === 'unknown' ? 0.5 : 0;
  const score = coverage * 100 + titleHits * 8 + headingHits * 18 + phraseHit * 24 + (exact ? 20 : 0)
    + applicability * 3 - Number(row.rank ?? 0) * 0.02;
  return { coverage, matched: matchedConcepts.length, titleHits, headingHits, phraseHit, exact,
    applicability: version, score };
}

export function buildExcerpt(text, concepts, maximum = 620) {
  const source = normalizeKnowledgeText(text);
  const lower = source.toLowerCase();
  let at = -1;
  for (const concept of concepts.flatMap(item => item.variants)) {
    const found = lower.indexOf(concept);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return source.slice(0, maximum);
  let start = Math.max(0, at - Math.floor(maximum * 0.28));
  let end = Math.min(source.length, start + maximum);
  if (start > 0) {
    const space = source.indexOf(' ', start);
    if (space >= 0 && space < at) start = space + 1;
  }
  if (end < source.length) {
    const space = source.lastIndexOf(' ', end);
    if (space > at) end = space;
  }
  return source.slice(start, end).trim();
}

export function boundedJson(payload, maximum = 3072) {
  const copy = { ...payload, rows: Array.isArray(payload.rows) ? payload.rows.slice() : undefined };
  let truncated = false;
  if (typeof copy.query === 'string' && copy.query.length > 300) {
    copy.query = copy.query.slice(0, 300) + '…';
    truncated = true;
  }
  if (typeof copy.nextCursor === 'string' && copy.nextCursor.length > 512) {
    copy.nextCursor = null;
    truncated = true;
  }
  const finish = () => {
    const body = { ...copy, truncated, bytes: 0, unit: 'bytes' };
    let bytes = 0;
    for (let pass = 0; pass < 4; pass += 1) body.bytes = bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    return body;
  };
  const measure = () => Buffer.byteLength(JSON.stringify(finish()), 'utf8');
  for (const size of [360, 240, 160, 100, 60]) {
    if (measure() <= maximum) break;
    for (const row of copy.rows || []) {
      if (typeof row.excerpt === 'string' && row.excerpt.length > size) {
        row.excerpt = row.excerpt.slice(0, size) + '…';
        truncated = true;
      }
      if (typeof row.title === 'string' && row.title.length > size) {
        row.title = row.title.slice(0, size) + '…';
        truncated = true;
      }
      if (typeof row.section === 'string' && row.section.length > size) {
        row.section = row.section.slice(0, size) + '…';
        truncated = true;
      }
      if (typeof row.sourceLabel === 'string' && row.sourceLabel.length > size) {
        row.sourceLabel = row.sourceLabel.slice(0, size) + '…';
        truncated = true;
      }
    }
  }
  while (measure() > maximum && copy.rows?.length) {
    copy.rows.pop();
    truncated = true;
  }
  while (measure() > maximum && copy.rows?.length > 1) {
    copy.rows.pop();
    truncated = true;
  }
  if (measure() > maximum) {
    delete copy.note;
    delete copy.fallbackReason;
    truncated = true;
  }
  if (measure() > maximum && copy.rows?.length) {
    copy.rows = [];
    truncated = true;
  }
  if (copy.status === 'hits' && (!copy.rows || copy.rows.length === 0)) copy.status = 'truncated';
  const final = finish();
  if (final.bytes > maximum) throw new Error('bounded JSON cannot fit within ' + maximum + ' bytes');
  return final;
}
