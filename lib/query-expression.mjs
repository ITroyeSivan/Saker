// One expression tree for authored FOFA fingerprints and the portable field:value DSL.
// No regex extraction, field overwrites, or partial compilation of unsupported terms.
export const QUERY_FIELDS = Object.freeze([
  'title', 'body', 'header', 'app', 'server', 'port', 'protocol', 'domain', 'ip', 'host',
  'icp', 'org', 'asn', 'city', 'region', 'cert', 'icon_hash', 'fid', 'product',
  'product.version', 'category', 'header_hash', 'banner_hash', 'banner_fid', 'banner',
  'jarm', 'base_protocol', 'status_code', 'cert.issuer.org', 'cert.issuer.cn',
  'cert.subject.org', 'cert.subject.cn', 'cert.domain', 'cert.sn', 'tls.ja3s', 'tls.version',
  'is_honeypot', 'is_fraud',
]);
const fields = new Set(QUERY_FIELDS);
const portable = Object.freeze({
  hunter: { title: 'web.title', body: 'web.body', header: 'web.header', app: 'app.name',
    server: 'web.server', port: 'ip.port', protocol: 'protocol', domain: 'domain', ip: 'ip', cert: 'cert' },
  quake: { title: 'title', body: 'body', header: 'header', app: 'app', server: 'server',
    port: 'port', protocol: 'protocol', domain: 'domain', ip: 'ip', cert: 'cert' },
});
const quote = value => '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

export function parseQueryExpression(input) {
  const source = String(input ?? '').trim();
  if (!source) throw new Error('查询为空');
  if (source.length > 8000) throw new Error('查询超过 8000 字符');
  let pos = 0, nodes = 0;
  const space = () => { while (/\s/.test(source[pos] || '') && pos < source.length) pos++; };
  const fail = () => { throw new Error(`无法解析的片段: "${source.slice(pos, pos + 80)}"`); };
  const node = value => { if (++nodes > 256) throw new Error('查询条件过多'); return value; };
  function atom(depth) {
    if (depth > 64) throw new Error('查询括号过深');
    space();
    if (source[pos] === '!') { pos++; return node({ type: 'not', value: atom(depth + 1) }); }
    if (source[pos] === '(') {
      pos++; const result = expression(depth + 1); space();
      if (source[pos++] !== ')') fail();
      return result;
    }
    const key = /^[a-z][a-z0-9_.]*/i.exec(source.slice(pos));
    if (!key) fail();
    const field = key[0].toLowerCase(); pos += key[0].length; space();
    const operator = /^(==|!=|=|:)/.exec(source.slice(pos));
    if (!operator) throw new Error('未识别到任何 字段:值 条件或 FOFA 表达式');
    if (!fields.has(field)) throw new Error(`未知字段 "${field}"`);
    const op = operator[0]; pos += op.length; space();
    let value = '';
    if (source[pos] === '"') {
      pos++; let closed = false;
      while (pos < source.length) {
        const ch = source[pos++];
        if (ch === '"') { closed = true; break; }
        if (ch === '\\') {
          const escaped = source[pos++];
          if (!['"', '\\'].includes(escaped)) throw new Error('查询含不支持的转义');
          value += escaped;
        } else value += ch;
      }
      if (!closed) throw new Error('查询字符串未闭合');
    } else {
      const bare = /^[^\s()&|!]+/.exec(source.slice(pos));
      if (!bare) fail(); value = bare[0]; pos += value.length;
    }
    if (!value || /[\r\n]/.test(value)) throw new Error(`字段 "${field}" 值为空或含换行`);
    return node({ type: 'term', field, op, value });
  }
  function conjunction(depth) {
    let left = atom(depth);
    while (true) {
      const before = pos; space();
      if (source.slice(pos, pos + 2) === '&&') { pos += 2; left = node({ type: 'and', left, right: atom(depth) }); }
      else if (/^(?:与|并且|且|and)(?=\s)/i.test(source.slice(pos))) {
        pos += /^(?:与|并且|且|and)/i.exec(source.slice(pos))[0].length;
        left = node({ type: 'and', left, right: atom(depth) });
      }
      else if (pos > before && (source[pos] === '(' || source[pos] === '!' || /^[a-z][a-z0-9_.]*\s*(?::|=|!=)/i.test(source.slice(pos)))) {
        left = node({ type: 'and', left, right: atom(depth) });
      } else break;
    }
    return left;
  }
  function expression(depth) {
    let left = conjunction(depth); space();
    while (source.slice(pos, pos + 2) === '||') {
      pos += 2; left = node({ type: 'or', left, right: conjunction(depth) }); space();
    }
    return left;
  }
  const tree = expression(0); space(); if (pos !== source.length) fail();
  return tree;
}

export function queryTerms(tree) {
  if (tree.type === 'term') return [tree];
  if (tree.type === 'not') return queryTerms(tree.value);
  return [...queryTerms(tree.left), ...queryTerms(tree.right)];
}

export function compileQueryExpression(tree, provider = 'fofa') {
  function render(item) {
    if (item.type === 'term') {
      let field = item.field, op = item.op;
      if (provider === 'fofa') {
        if (op === ':') op = ['domain', 'host', 'icp', 'asn'].includes(field)
          || (field === 'ip' && !item.value.includes('/')) ? '==' : '=';
      } else {
        // Native FOFA equality semantics are not asserted equivalent on another provider.
        if (op !== ':' || !portable[provider]?.[field]) throw new Error('unsupported');
        field = portable[provider][field]; op = provider === 'quake' ? ':' : '=';
      }
      return field + op + quote(item.value);
    }
    if (item.type === 'not') {
      if (provider !== 'fofa') throw new Error('unsupported');
      return '!(' + render(item.value) + ')';
    }
    const op = provider === 'quake' ? (item.type === 'and' ? ' AND ' : ' OR ')
      : (item.type === 'and' ? ' && ' : ' || ');
    return '(' + render(item.left) + op + render(item.right) + ')';
  }
  try { return render(tree); } catch (error) { if (error.message === 'unsupported') return ''; throw error; }
}

// Every OR branch must contain a positive identity restriction. A negative
// condition or one identity-bearing branch cannot constrain its sibling.
export function everyBranchHasField(tree, allowedFields) {
  if (tree.type === 'term') return tree.op !== '!=' && allowedFields.has(tree.field);
  if (tree.type === 'not') return false;
  const left = everyBranchHasField(tree.left, allowedFields);
  const right = everyBranchHasField(tree.right, allowedFields);
  return tree.type === 'and' ? left || right : left && right;
}
