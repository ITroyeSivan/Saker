// dsh-knowledge-hub — web client.
// Registers a "知识库" settings section: two-layer refs browser (bundle
// read-only / user writable / imports), file preview + edit + create + delete,
// git-source import, and a search test box. All calls go through the plugin's
// loopback RPC channel (/dsh-knowledge-hub).
window.__ModuleLoader__.load({ id: '@dsh-external/dsh-knowledge-hub', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict';
var React = require('react');
var useState = React.useState, useEffect = React.useEffect;

var CHANNEL = '/dsh-knowledge-hub';
var MODES = [
  { id: 'pentest', label: '渗透测试' },
  { id: 'code-audit', label: '代码审计' },
  { id: 'ctf-solver', label: 'CTF 解题' },
];

function rpc(connection, endpoint, payload) {
  return connection.rpc.call(CHANNEL, endpoint, payload);
}
function isOk(r) { return !!(r && r.ok); }
// 连接层的失败是结构化对象 `{code,message,details}`；旧代码直接把它当字符串渲染，
// 会抛 "Objects are not valid as a React child"。两种形状都接住。
function errText(r) {
  var e = r && r.error;
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  return e.message || '未知错误';
}

var CSS = {
  field: { display: 'block', width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1, #d9d9de)', background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-label-primary, #1a1a1a)', fontSize: 13, boxSizing: 'border-box' },
  label: { display: 'block', margin: '10px 0 4px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #6e6e73)' },
  groupTitle: { fontSize: 13, fontWeight: 600, margin: '0 0 4px', color: 'var(--dsw-alias-label-primary, #1a1a1a)' },
  hint: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #6e6e73)' },
};
function btn(primary, extra) {
  return Object.assign({
    padding: '7px 14px', borderRadius: 6,
    border: '1px solid ' + (primary ? 'transparent' : 'var(--dsw-alias-border-l1,#d9d9de)'),
    background: primary ? '#2f81f7' : 'transparent',
    color: primary ? '#fff' : 'var(--dsw-alias-label-primary,#1a1a1a)',
    fontSize: 13, fontWeight: 600, cursor: 'pointer',
  }, extra || {});
}
function msgStyle(okv) { return { marginTop: 8, fontSize: 12, color: okv ? '#1a7f37' : '#d1242f' }; }
function badge(bg, fg, text, title) {
  return React.createElement('span', {
    style: { display: 'inline-flex', alignItems: 'center', padding: '1px 7px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: bg, color: fg, lineHeight: '16px', whiteSpace: 'nowrap', marginLeft: 6 },
    title: title || '',
  }, text);
}
var SOURCE_META = {
  bundle: { label: '包内', bg: '#e4e4e7', fg: '#6e6e73' },
  patt: { label: 'PATT', bg: '#fff7ed', fg: '#c2410c' },
  user: { label: '用户', bg: '#dbeafe', fg: '#1d4ed8' },
  import: { label: '导入', bg: '#f3e8ff', fg: '#7c3aed' },
};
var SOURCE_TABS = [
  { id: 'patt', title: '随包 PATT', writable: false },
  { id: 'bundle', title: '随包手册', writable: false },
  { id: 'user', title: '用户积累', writable: true },
  { id: 'import', title: '导入知识源', writable: true },
];

// Normalized inputs: strip onChange and re-attach a handler that forwards
// e.target.value (same contract as sec-config). Consumers always receive the
// plain string value, never the React event object.
function Input(props) {
  var rest = {};
  for (var k in props) if (k !== 'onChange') rest[k] = props[k];
  return React.createElement('input', Object.assign({ type: 'text', style: CSS.field }, rest, {
    onChange: typeof props.onChange === 'function'
      ? function (e) { props.onChange(e.target.value); }
      : undefined,
  }));
}
function TextArea(props) {
  var rest = {};
  for (var k in props) if (k !== 'onChange') rest[k] = props[k];
  return React.createElement('textarea', Object.assign({ style: Object.assign({ minHeight: 340, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12, lineHeight: 1.55, resize: 'vertical' }, CSS.field) }, rest, {
    onChange: typeof props.onChange === 'function'
      ? function (e) { props.onChange(e.target.value); }
      : undefined,
  }));
}

// ── Lightweight Markdown preview ───────────────────────────────────────────
// The knowledge base is mostly Markdown documentation and imported repos.
// Rendering it through React elements (never innerHTML) keeps imported content
// readable without opening an XSS surface. Support the constructs that matter
// for playbooks: headings, lists, fenced code, links, inline code and emphasis.

function markdownParts(text) {
  var body = String(text || '').replace(/\r\n/g, '\n');
  var meta = [];
  var fm = /^\uFEFF?\s*---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(body);
  if (fm) {
    var raw = fm[1].split('\n');
    for (var i = 0; i < raw.length; i += 1) {
      var line = raw[i];
      var at = line.indexOf(':');
      if (at <= 0) continue;
      var key = line.slice(0, at).trim();
      var val = line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
      if (/^[A-Za-z0-9_.-]+$/.test(key) && val && val !== '|' && val !== '>') meta.push([key, val]);
    }
    body = body.slice(fm[0].length);
  }
  return { meta: meta, body: body };
}

function markdownInline(text, prefix) {
  var src = String(text || '');
  var out = [];
  var re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  var last = 0;
  var match;
  var n = 0;
  while ((match = re.exec(src)) !== null) {
    if (match.index > last) out.push(src.slice(last, match.index));
    if (match[1]) {
      out.push(React.createElement('a', {
        key: prefix + '-a' + n,
        href: match[2],
        target: '_blank',
        rel: 'noreferrer',
        style: { color: '#1d4ed8', textDecoration: 'underline', wordBreak: 'break-all' },
      }, match[1]));
    } else if (match[3]) {
      out.push(React.createElement('code', {
        key: prefix + '-c' + n,
        style: { padding: '1px 4px', borderRadius: 4, background: 'var(--dsw-alias-bg-fill,#f0f2f5)', fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12 },
      }, match[3]));
    } else {
      out.push(React.createElement('strong', { key: prefix + '-b' + n }, match[4]));
    }
    last = re.lastIndex;
    n += 1;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

function MarkdownPreview(props) {
  var parsed = markdownParts(props.content);
  var lines = parsed.body.split('\n');
  var nodes = [];
  var code = [];
  var inCode = false;
  var list = [];
  var listType = '';

  function flushList() {
    if (!list.length) return;
    var tag = listType === 'ol' ? 'ol' : 'ul';
    nodes.push(React.createElement(tag, {
      key: 'list-' + nodes.length,
      style: { margin: '5px 0 8px', paddingLeft: 22, lineHeight: 1.7 },
    }, list));
    list = [];
    listType = '';
  }

  function flushCode() {
    if (!code.length) return;
    nodes.push(React.createElement('pre', {
      key: 'code-' + nodes.length,
      style: { margin: '8px 0', padding: '10px 12px', borderRadius: 6, overflowX: 'auto', background: '#f6f8fa', border: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', lineHeight: 1.55 },
    }, React.createElement('code', { style: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12, whiteSpace: 'pre' } }, code.join('\n'))));
    code = [];
  }

  for (var i = 0; i < lines.length; i += 1) {
    var line = lines[i];
    if (/^```/.test(line.trim())) {
      if (inCode) { flushCode(); inCode = false; }
      else { flushList(); inCode = true; }
      continue;
    }
    if (inCode) { code.push(line); continue; }
    var heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushList();
      var level = heading[1].length;
      var sizes = { 1: 18, 2: 16, 3: 14, 4: 13 };
      nodes.push(React.createElement('div', {
        key: 'h-' + i,
        style: { margin: level === 1 ? '6px 0 8px' : '12px 0 5px', fontSize: sizes[level], fontWeight: 700, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary,#1a1a1a)' },
      }, markdownInline(heading[2], 'h' + i)));
      continue;
    }
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      flushList();
      nodes.push(React.createElement('hr', { key: 'hr-' + i, style: { border: 0, borderTop: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', margin: '10px 0' } }));
      continue;
    }
    var bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    var ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (bullet || ordered) {
      var nextType = bullet ? 'ul' : 'ol';
      if (list.length && listType !== nextType) flushList();
      listType = nextType;
      list.push(React.createElement('li', { key: 'li-' + i, margin: '2px 0' }, markdownInline((bullet || ordered)[1], 'li' + i)));
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    var quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      nodes.push(React.createElement('blockquote', {
        key: 'q-' + i,
        style: { margin: '7px 0', padding: '1px 0 1px 10px', borderLeft: '3px solid #c7d2fe', color: '#52525b', lineHeight: 1.7 },
      }, markdownInline(quote[1], 'q' + i)));
      continue;
    }
    nodes.push(React.createElement('div', {
      key: 'p-' + i,
      style: { margin: '5px 0', lineHeight: 1.72, color: 'var(--dsw-alias-label-secondary,#3f3f46)', wordBreak: 'break-word' },
    }, markdownInline(line, 'p' + i)));
  }
  if (inCode) flushCode();
  flushList();

  return React.createElement('div', {
    style: { minHeight: 340, maxHeight: 560, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', borderRadius: 8, padding: '12px 14px', background: 'var(--dsw-alias-bg-base,#fff)', fontSize: 13, boxSizing: 'border-box' },
  },
    parsed.meta.length ? React.createElement('div', {
      style: { display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: '3px 10px', padding: '8px 10px', marginBottom: 8, borderRadius: 6, background: 'var(--dsw-alias-bg-fill,#f7f7f8)', fontSize: 11, lineHeight: 1.5 },
    }, parsed.meta.slice(0, 12).flatMap(function (row, i) {
      return [
        React.createElement('span', { key: 'mk' + i, style: { color: '#9a9aa0', fontFamily: 'ui-monospace, monospace' } }, row[0]),
        React.createElement('span', { key: 'mv' + i, style: { color: '#52525b', overflowWrap: 'anywhere', wordBreak: 'break-word' } }, row[1]),
      ];
    })) : null,
    nodes.length ? nodes : React.createElement('div', { style: { color: '#9a9aa0' } }, '（空文档）'));
}

// ── Directory tree section ──────────────────────────────────────────────────
// Each source is shown as "category groups" — the top-level directories are
// rendered as bold category headers carrying a recursive file-count badge,
// so a large knowledge base (e.g. the bundled PATT chapters) reads as tidy
// grouped sections instead of one piled-up indented list.

function TreeRow(props) {
  var item = props.item;
  var isCat = item.kind === 'dir' && props.depth === 0;
  var indent = { paddingLeft: 8 + props.depth * 14, display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, borderRadius: 4, paddingTop: 2, paddingBottom: 2, cursor: 'pointer' };
  if (isCat) { indent.marginTop = 2; indent.background = 'var(--dsw-alias-bg-fill,#f4f4f5)'; indent.fontWeight = 600; }
  var active = props.active ? { background: 'var(--dsw-alias-bg-fill, #f0f2f5)' } : null;
  var arrow = item.kind === 'dir' ? (item.expanded ? '▾ ' : '▸ ') : '  ';
  var name = React.createElement('span', { style: { color: item.kind === 'dir' ? 'var(--dsw-alias-label-primary,#1a1a1a)' : 'var(--dsw-alias-label-secondary,#3f3f46)', fontWeight: item.kind === 'dir' ? (isCat ? 600 : 600) : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name);
  var meta = null;
  if (item.kind === 'file' && item.size > 0) {
    meta = React.createElement('span', { style: { fontSize: 11, color: '#9a9aa0', marginLeft: 'auto', flex: '0 0 auto' } }, (item.size / 1024).toFixed(1) + ' KB');
  } else if (item.kind === 'dir' && typeof item.fileCount === 'number') {
    meta = badge('#eef2ff', '#4338ca', String(item.fileCount) + ' 文件', '分类内文本文件数');
  }
  return React.createElement('div', { style: Object.assign(indent, active), onClick: props.onClick, title: isCat ? '分类：' + item.name : undefined },
    React.createElement('span', { style: { color: '#9a9aa0', fontSize: 11 } }, arrow),
    name, meta);
}

function TreeSection(props) {
  var meta = SOURCE_META[props.source];
  var [rootChildren, setRootChildren] = useState(null);
  var [msg, setMsg] = useState('');
  var [filter, setFilter] = useState('');
  var [remoteHits, setRemoteHits] = useState(null);
  var [remoteBusy, setRemoteBusy] = useState(false);
  var [remoteMsg, setRemoteMsg] = useState('');

  function refreshRoot() {
    rpc(props.connection, 'browse', { source: props.source, mode: props.mode, dir: '' }).then(function (r) {
      if (isOk(r)) { setRootChildren(r.value); if (msg) setMsg(''); }
      else setMsg(errText(r));
    });
  }
  useEffect(refreshRoot, [props.source, props.mode, props.reloadTick]);

  // Expand cache: dirKey -> {dirs, files} | null(not loaded)
  var [cache, setCache] = useState({});
  var [expanded, setExpanded] = useState({});

  // Mode/source switch must drop cached subtrees from the previous layer.
  // reloadTick intentionally does NOT clear these — an edit save should not
  // collapse the tree; structural changes only re-browse the root (refreshRoot).
  useEffect(function () { setCache({}); setExpanded({}); }, [props.source, props.mode]);

  function toggleDir(node) {
    var dir = node.rel;
    if (expanded[dir]) {
      var nx = JSON.parse(JSON.stringify(expanded)); delete nx[dir];
      var nc = JSON.parse(JSON.stringify(cache)); delete nc[dir];
      setExpanded(nx); setCache(nc);
      return;
    }
    var ex = JSON.parse(JSON.stringify(expanded)); ex[dir] = true; setExpanded(ex);
    if (!cache[dir]) {
      rpc(props.connection, 'browse', { source: props.source, mode: props.mode, dir: dir }).then(function (r) {
        if (isOk(r)) { var c = JSON.parse(JSON.stringify(cache)); c[dir] = r.value; setCache(c); }
        else setMsg(errText(r));
      });
    }
  }

  function openFile(node) {
    props.onOpen({ source: props.source, mode: props.mode, path: node.rel, name: node.name });
  }

  var nodes = rootChildren || { dirs: [], files: [] };
  var filterTerm = filter.trim().toLowerCase();
  // 来源内筛选不能只匹配“已经展开的子树”：PATT/导入层动辄几十个分类，
  // 用户输入文件名时往往还没有展开目标分类。这里用已有检索索引做来源限定
  // 的跨目录查找；结果只作为临时扁平列表，不改变目录树展开状态。
  useEffect(function () {
    if (!filterTerm) {
      setRemoteHits(null); setRemoteBusy(false); setRemoteMsg('');
      return undefined;
    }
    var stale = false;
    setRemoteBusy(true); setRemoteMsg('');
    var timer = setTimeout(function () {
      rpc(props.connection, 'search', { query: filter, mode: props.mode, source: props.source, limit: 50 }).then(function (r) {
        if (stale) return;
        setRemoteBusy(false);
        if (isOk(r)) setRemoteHits(Array.isArray(r.value && r.value.hits) ? r.value.hits : []);
        else { setRemoteHits([]); setRemoteMsg(errText(r)); }
      }).catch(function (e) {
        if (stale) return;
        setRemoteBusy(false); setRemoteHits([]); setRemoteMsg(String((e && e.message) || e));
      });
    }, 250);
    return function () { stale = true; clearTimeout(timer); };
  }, [filterTerm, props.source, props.mode]);
  function openRemote(hit) {
    var rel = String((hit && hit.path) || '');
    if (!rel) return;
    props.onOpen({
      source: (hit && hit.source) || props.source,
      mode: props.mode,
      path: rel,
      name: rel.split(/[\\/]/).pop(),
    });
  }
  function remoteRows() {
    if (remoteBusy) return [React.createElement('div', { key: 'remote-busy', style: { padding: '9px 6px', fontSize: 12, color: '#9a9aa0' } }, '检索中…')];
    if (remoteHits === null) return [];
    if (remoteHits.length === 0) return [React.createElement('div', { key: 'remote-empty', style: { padding: '9px 6px', fontSize: 12, color: '#9a9aa0' } }, remoteMsg || '当前来源没有匹配文件')];
    var seen = {};
    var rows = [];
    remoteHits.forEach(function (hit, i) {
      var rel = String((hit && hit.path) || '');
      if (!rel) return;
      var source = (hit && hit.source) || props.source;
      var key = source + ':' + rel;
      if (seen[key]) return;
      seen[key] = 1;
      var active = props.activeFile && props.activeFile.source === source && props.activeFile.path === rel;
      rows.push(React.createElement('div', {
        key: 'remote-' + key + '-' + i,
        title: rel,
        onClick: function () { openRemote(hit); },
        style: { display: 'flex', alignItems: 'flex-start', gap: 6, padding: '5px 7px', borderRadius: 4, cursor: 'pointer', fontSize: 12, lineHeight: 1.45, background: active ? 'var(--dsw-alias-bg-fill,#f0f2f5)' : 'transparent' },
      },
        badge(SOURCE_META[source] ? SOURCE_META[source].bg : '#e4e4e7', SOURCE_META[source] ? SOURCE_META[source].fg : '#6e6e73', SOURCE_META[source] ? SOURCE_META[source].label : source),
        React.createElement('span', { style: { minWidth: 0, color: 'var(--dsw-alias-label-secondary,#3f3f46)', overflowWrap: 'anywhere' } }, rel, hit && hit.line ? ':' + hit.line : '')));
    });
    return rows.length ? rows : [React.createElement('div', { key: 'remote-empty', style: { padding: '9px 6px', fontSize: 12, color: '#9a9aa0' } }, '当前来源没有匹配文件')];
  }
  function matchesNode(item) {
    return String(item.name || '').toLowerCase().includes(filterTerm);
  }
  function filterChildren(children, prefix) {
    if (!filterTerm || !children) return children;
    var dirs = (children.dirs || []).filter(function (dir) {
      var rel = prefix ? prefix + '/' + dir.name : dir.name;
      if (matchesNode(dir)) return true;
      var loaded = cache[rel];
      if (!loaded) return false;
      var nested = filterChildren(loaded, rel);
      return nested.dirs.length > 0 || nested.files.length > 0;
    });
    return { dirs: dirs, files: (children.files || []).filter(matchesNode) };
  }
  function renderChildren(children, depth, prefix) {
    if (!children) return [];
    children = filterChildren(children, prefix) || { dirs: [], files: [] };
    var rows = [];
    var keyOf = function (x) { return prefix ? prefix + '/' + x.name : x.name; };
    children.dirs.forEach(function (d) {
      var key = keyOf(d);
      var node = { kind: 'dir', name: d.name, rel: key, expanded: !!expanded[key], fileCount: d.fileCount };
      rows.push(React.createElement(TreeRow, { key: 'd' + key, item: node, depth: depth, onClick: function () { toggleDir(node); } }));
      if (expanded[key] && cache[key]) {
        rows = rows.concat(renderChildren(cache[key], depth + 1, key));
      }
    });
    if (depth === 0 && children.files.length > 0) {
      rows.push(React.createElement('div', { key: '_rootfiles', style: { fontSize: 11, color: '#9a9aa0', margin: '4px 0 2px 24px' } }, '根目录文件'));
    }
    children.files.forEach(function (f) {
      var key = keyOf(f);
      var node = { kind: 'file', name: f.name, rel: key, size: f.size };
      var active = props.activeFile && props.activeFile.source === props.source && props.activeFile.path === key;
      rows.push(React.createElement(TreeRow, { key: 'f' + key, item: node, depth: depth, active: active, onClick: function () { openFile(node); } }));
    });
    return rows;
  }

  var summary = null;
  if (rootChildren) {
    var dirSum = (rootChildren.dirs || []).reduce(function (a, d) { return a + (d.fileCount || 0); }, 0);
    var fileSum = (rootChildren.files || []).length;
    summary = React.createElement('span', { style: { fontSize: 11, color: '#9a9aa0', marginLeft: 'auto' } },
      rootChildren.dirs.length + ' 分类 · ' + (dirSum + fileSum) + ' 文件');
  }

  return React.createElement('div', { style: { marginBottom: 6 } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', padding: '3px 4px' } },
      React.createElement('span', { style: { fontWeight: 600, fontSize: 13 } }, props.title),
      badge(meta.bg, meta.fg, meta.label),
      props.writable ? badge('#e6ffed', '#1a7f37', '可写') : null,
      summary),
    React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', margin: '5px 0 7px' } },
      React.createElement('input', {
        value: filter,
        placeholder: '筛选当前来源的分类或文件…',
        onChange: function (e) { setFilter(e.target.value); },
        style: Object.assign({}, CSS.field, { padding: '6px 8px', fontSize: 12 }),
      }),
      filter ? React.createElement('button', {
        type: 'button',
        onClick: function () { setFilter(''); },
        style: btn(false, { padding: '5px 9px', fontSize: 12, whiteSpace: 'nowrap' }),
      }, '清除') : null),
    React.createElement('div', { style: { marginTop: 2 } }, filterTerm ? remoteRows() : renderChildren(nodes, 0, '')),
    msg ? React.createElement('div', { style: msgStyle(false) }, msg) : null);
}

// ── Editor ──────────────────────────────────────────────────────────────────

function Editor(props) {
  var meta = SOURCE_META[props.file ? props.file.source : 'bundle'];
  var writable = props.file && (props.file.source === 'user' || props.file.source === 'import');
  var [content, setContent] = useState('');
  var [dirty, setDirty] = useState(false);
  var [busy, setBusy] = useState(false);
  var [msg, setMsg] = useState(null);
  var [viewMode, setViewMode] = useState('preview');
  // 删除的行内两段式确认（原生 confirm 会阻塞渲染进程，Agent 驱动的整页卡死）
  var [confirmDel, setConfirmDel] = useState(false);

  useEffect(function () {
    if (!props.file) { setContent(''); setDirty(false); return; }
    setBusy(true); setMsg(null); setConfirmDel(false);
    setViewMode(props.file.source === 'user' || props.file.source === 'import' ? 'source' : 'preview');
    rpc(props.connection, 'read', { source: props.file.source, mode: props.file.mode, path: props.file.path }).then(function (r) {
      setBusy(false);
      if (isOk(r)) { setContent(r.value.content); setDirty(false); }
      else setMsg({ ok: false, text: errText(r) });
    }).catch(function (e) {
      // RPC 被 reject（宿主重启、连接层协议错等）也必须清 busy —— 否则按钮永远"保存中…"，
      // 详情区一片空白且没有任何原因可看。这正是 2026-09-19 那个白板 bug 的形态。
      setBusy(false); setMsg({ ok: false, text: '读取失败：' + String((e && e.message) || e) });
    });
  }, [props.file && props.file.source + '|' + props.file.mode + '|' + props.file.path]);

  if (!props.file) {
    return React.createElement('div', { style: { color: '#9a9aa0', fontSize: 13, padding: 40, textAlign: 'center', border: '1px dashed var(--dsw-alias-border-l1,#e4e4e7)', borderRadius: 8, height: '100%', minHeight: 340, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center' } },
      '左侧选择文件。随包手册 / 随包 PATT 只读预览；用户 / 导入层可编辑、新建与删除。');
  }

  function save() {
    setBusy(true); setMsg(null);
    rpc(props.connection, 'write', { source: props.file.source, mode: props.file.mode, path: props.file.path, content: content }).then(function (r) {
      setBusy(false);
      if (isOk(r)) {
        // 覆盖已有文件时服务端会先备份到同层 .backups/ —— 明确告诉用户还能回退
        var backed = r.value && r.value.backup;
        setDirty(false);
        setMsg({ ok: true, text: backed ? '已保存（旧版已备份到同层 .backups/；下一次检索/会话即生效）' : '已保存（下一次检索/会话即生效）' });
        props.onChanged();
      }
      else setMsg({ ok: false, text: errText(r) });
    }).catch(function (e) { setBusy(false); setMsg({ ok: false, text: '保存失败：' + String((e && e.message) || e) }); });
  }
  function remove() {
    setConfirmDel(false);
    setBusy(true); setMsg(null);
    rpc(props.connection, 'remove', { source: props.file.source, mode: props.file.mode, path: props.file.path }).then(function (r) {
      setBusy(false);
      if (isOk(r)) {
        // 服务端是「移进同层 .trash/」而不是直接 rm —— 告诉用户删掉的东西还在，可人工找回。
        var trashed = r.value && r.value.trash;
        props.onDeleted(trashed ? '已删除（移入同层 .trash/，可人工找回）' : '已删除');
      }
      else setMsg({ ok: false, text: errText(r) });
    }).catch(function (e) { setBusy(false); setMsg({ ok: false, text: '删除失败：' + String((e && e.message) || e) }); });
  }

  var metaBadge = badge(meta.bg, meta.fg, meta.label + '层');
  var pathLine = React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
    props.onBack ? React.createElement('button', { type: 'button', style: btn(false, { padding: '3px 8px', fontSize: 12 }), onClick: props.onBack }, '← 返回列表') : null,
    React.createElement('span', { style: { fontSize: 12, color: '#3f3f46', wordBreak: 'break-all' } }, props.file.mode ? props.file.mode + '/' : '', props.file.path),
    metaBadge,
    writable && dirty ? React.createElement('span', { style: { fontSize: 12, color: '#9a6700' } }, '（未保存）') : null);

  return React.createElement('div', null,
    pathLine,
    React.createElement('div', { style: { marginTop: 8 } },
      React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 7 } },
        React.createElement('button', { type: 'button', style: btn(viewMode === 'preview', { padding: '4px 10px', fontSize: 12 }), onClick: function () { setViewMode('preview'); } }, '预览'),
        React.createElement('button', { type: 'button', style: btn(viewMode === 'source', { padding: '4px 10px', fontSize: 12 }), onClick: function () { setViewMode('source'); } }, '源码')),
      viewMode === 'preview'
        ? React.createElement(MarkdownPreview, { content: content })
        : React.createElement(TextArea, { value: content, readOnly: !writable, disabled: busy, spellCheck: false, onChange: function (v) { setContent(v); setDirty(true); } })),
    React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
      writable ? React.createElement('button', { type: 'button', disabled: busy, style: btn(true), onClick: save }, busy ? '保存中…' : '保存（写用户层）') : null,
      writable ? (confirmDel
        ? React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 } },
          '删除 ' + props.file.path + ' ？（仅删除 ' + meta.label + ' 层文件，不可恢复）',
          React.createElement('button', { type: 'button', disabled: busy, style: btn(false, { borderColor: '#d1242f', background: '#fff5f5', color: '#d1242f', fontWeight: 700 }), onClick: remove }, '删除'),
          React.createElement('button', { type: 'button', disabled: busy, style: btn(false), onClick: function () { setConfirmDel(false); } }, '取消'))
        : React.createElement('button', { type: 'button', disabled: busy, style: btn(false), onClick: function () { setConfirmDel(true); } }, '删除')) : null,
      msg ? React.createElement('span', { style: msgStyle(msg.ok) }, msg.text) : null));
}

// ── Import + search bar ─────────────────────────────────────────────────────

function ImportBox(props) {
  var [url, setUrl] = useState('');
  var [name, setName] = useState('');
  var [dirPath, setDirPath] = useState('');
  var [dirName, setDirName] = useState('');
  var [busy, setBusy] = useState(''); // '' | 'git' | 'local'
  var [msg, setMsg] = useState(null);

  function runGit() {
    if (!url.trim() || !name.trim() || busy) return;
    setBusy('git'); setMsg(null);
    rpc(props.connection, 'import_git', { url: url.trim(), name: name.trim() }).then(function (r) {
      setBusy('');
      if (isOk(r)) {
        var ref = r.value && r.value.ref ? '（snapshot ' + r.value.ref + '）' : '';
        setMsg({ ok: true, text: '导入完成：' + r.value.path + ref + '，已离线可用，检索覆盖导入层。' });
        setUrl(''); setName('');
        props.onChanged();
      } else setMsg({ ok: false, text: errText(r) });
    });
  }
  function runLocal() {
    if (!dirPath.trim() || !dirName.trim() || busy) return;
    setBusy('local'); setMsg(null);
    rpc(props.connection, 'import_local', { path: dirPath.trim(), name: dirName.trim() }).then(function (r) {
      setBusy('');
      if (isOk(r)) {
        setMsg({ ok: true, text: '导入完成：' + r.value.path + '（' + r.value.files + ' 个文件，跳过 .git），已离线可用。' });
        setDirPath(''); setDirName('');
        props.onChanged();
      } else setMsg({ ok: false, text: errText(r) });
    });
  }

  return React.createElement('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', paddingTop: 12 } },
    React.createElement('div', { style: CSS.groupTitle }, '导入外部知识源（远程 Git）'),
    React.createElement('div', { style: Object.assign({}, CSS.hint, { marginBottom: 6 }) },
      '克隆公开 Git 仓库（如 github.com/swisskyrepo/PayloadsAllTheThings，MIT 协议）到导入区，之后完全离线可用。需要本机能访问该地址；成功后显示来源 commit。'),
    React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      React.createElement('div', { style: { flex: 3 } }, React.createElement(Input, { value: url, placeholder: 'Git 仓库 URL（https://…）', onChange: setUrl })),
      React.createElement('div', { style: { flex: 1 } }, React.createElement(Input, { value: name, placeholder: '名称（如 payloads-all-the-things）', onChange: setName })),
      React.createElement('button', { type: 'button', disabled: !!busy || !url.trim() || !name.trim(), style: btn(true), onClick: runGit }, busy === 'git' ? '导入中…' : '导入')),
    React.createElement('div', { style: { marginTop: 14 } },
      React.createElement('div', { style: CSS.groupTitle }, '导入本机文件夹'),
      React.createElement('div', { style: Object.assign({}, CSS.hint, { marginBottom: 6 }) },
        '把运行 dsh 这台机器上的现有目录整体复制进导入区（自动跳过 .git）。例如本地已 clone 的 PayloadsAllTheThings，或团队共享的知识目录；离线最稳。'),
      React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
        React.createElement('div', { style: { flex: 3 } }, React.createElement(Input, { value: dirPath, placeholder: '本机文件夹绝对路径（如 D:\\kb\\PayloadsAllTheThings）', onChange: setDirPath })),
        React.createElement('div', { style: { flex: 1 } }, React.createElement(Input, { value: dirName, placeholder: '名称（如 payloads-all-the-things）', onChange: setDirName })),
        React.createElement('button', { type: 'button', disabled: !!busy || !dirPath.trim() || !dirName.trim(), style: btn(true), onClick: runLocal }, busy === 'local' ? '导入中…' : '导入'))),
    msg ? React.createElement('div', { style: msgStyle(msg.ok), marginTop: 8 }, msg.text) : null);
}

function SearchBar(props) {
  return React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 } },
    React.createElement('div', { style: { flex: 1, minWidth: 0 } },
      React.createElement(Input, {
        value: props.query,
        placeholder: '全局检索知识库，如 fastjson / jwt / Sigma powershell',
        onChange: props.onChange,
        onKeyDown: function (e) { if (e.key === 'Enter') props.onRun(); },
        style: Object.assign({}, CSS.field, { border: '1px solid var(--dsw-alias-border-l2,#c9c9cf)', background: 'var(--dsw-alias-bg-base,#fff)' }),
      })),
    React.createElement('button', { type: 'button', disabled: props.busy || !props.query.trim(), style: btn(true, { padding: '7px 12px' }), onClick: props.onRun }, props.busy ? '检索中…' : '检索'),
    props.active ? React.createElement('button', { type: 'button', style: btn(false, { padding: '7px 12px' }), onClick: props.onClear }, '返回目录') : null);
}

function SearchResults(props) {
  var hits = props.hits || [];
  if (props.busy) {
    return React.createElement('div', { style: { color: '#6e6e73', fontSize: 12, padding: 8 } }, '检索中…');
  }
  if (props.error) {
    return React.createElement('div', { style: { color: '#d1242f', fontSize: 12, padding: 8 } }, '检索失败：' + props.error);
  }
  if (hits.length === 0) {
    return React.createElement('div', { style: { color: '#9a9aa0', fontSize: 12, padding: 8 } }, '没有命中。换一个工具名、CVE 或更短的关键词。');
  }
  return React.createElement('div', null,
    React.createElement('div', { style: { fontSize: 11, color: '#9a9aa0', margin: '2px 4px 6px' } }, '命中 ' + hits.length + ' 条'),
    hits.map(function (h, i) {
      var m = SOURCE_META[h.source] || SOURCE_META.bundle;
      var path = (h.mode ? h.mode + '/' : '') + h.path + (h.line ? ':' + h.line : '');
      return React.createElement('div', {
        key: i,
        title: path + (h.preview ? '\n' + h.preview : ''),
        style: { display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: 6, padding: '6px 4px', borderRadius: 5, cursor: 'pointer', fontSize: 12, borderBottom: '1px solid var(--dsw-alias-border-l1,#f0f0f2)' },
        onMouseEnter: function (e) { e.currentTarget.style.background = 'var(--dsw-alias-bg-fill,#f0f2f5)'; },
        onMouseLeave: function (e) { e.currentTarget.style.background = 'transparent'; },
        onClick: function () { props.onOpen({ source: h.source, mode: h.mode || props.mode, path: h.path, name: h.path.split('/').pop() }); },
      },
        badge(m.bg, m.fg, m.label),
        React.createElement('div', { style: { minWidth: 0 } },
          React.createElement('div', { style: { color: '#3f3f46', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, path),
          h.preview ? React.createElement('div', { style: { color: '#9a9aa0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 } }, h.preview) : null));
    }));
}

// ── Page ────────────────────────────────────────────────────────────────────

function PackCard(props) {
  var [st, setSt] = useState({ loading: true });
  var [busy, setBusy] = useState('');
  var [notice, setNotice] = useState(null);
  var [expanded, setExpanded] = useState(false);
  var [showAdmin, setShowAdmin] = useState(false);
  function status() {
    rpc(props.connection, 'packs-status', {}).then(function (r) {
      setSt(isOk(r) ? r.value : { error: errText(r) });
    });
  }
  useEffect(status, [props.reloadTick]);
  function syncAll() {
    setBusy('sync'); setNotice(null);
    rpc(props.connection, 'packs-sync', { force: true }).then(function (r) {
      setBusy('');
      if (isOk(r)) {
        setNotice({ ok: r.value.failed === 0, text: '同步完成：' + r.value.ok + ' 成功 / ' + r.value.failed + ' 失败' });
        status(); props.onChanged();
      } else setNotice({ ok: false, text: errText(r) });
    }).catch(function (e) { setBusy(''); setNotice({ ok: false, text: String(e && e.message || e) }); });
  }
  function syncOne(id) {
    setBusy('sync:' + id); setNotice(null);
    rpc(props.connection, 'packs-sync', { ids: [id], force: true }).then(function (r) {
      setBusy('');
      if (isOk(r)) {
        var result = r.value.results && r.value.results[0];
        var recovered = result && result.recovered && result.backup;
        setNotice({
          ok: r.value.failed === 0,
          text: recovered
            ? '已自动重克隆，旧目录备份在：' + result.backup
            : '同步完成：' + r.value.ok + ' 成功 / ' + r.value.failed + ' 失败',
        });
        status(); props.onChanged();
      } else setNotice({ ok: false, text: errText(r) });
    }).catch(function (e) { setBusy(''); setNotice({ ok: false, text: String(e && e.message || e) }); });
  }
  function setMode(mode) {
    setBusy('mode:' + mode); setNotice(null);
    rpc(props.connection, 'packs-mode', { mode: mode }).then(function (r) {
      setBusy('');
      if (isOk(r)) {
        setNotice({ ok: true, text: mode === 'auto' ? '已恢复自动同步' : mode === 'manual' ? '已切换为手动同步' : '已冻结知识同步，不再主动访问网络' });
        status();
      } else setNotice({ ok: false, text: errText(r) });
    }).catch(function (e) { setBusy(''); setNotice({ ok: false, text: String(e && e.message || e) }); });
  }
  function rebuild() {
    setBusy('index'); setNotice(null);
    rpc(props.connection, 'index-rebuild', {}).then(function (r) {
      setBusy('');
      if (isOk(r)) {
        if (r.value.started) {
          setNotice({ ok: true, text: '索引已在后台重建，完成后 knowledge_search 自动切换。' });
          setTimeout(status, 3000);
        } else {
          setNotice({ ok: true, text: '索引完成：' + r.value.docs + ' 文档 / ' + r.value.chunks + ' chunks' });
        }
        status(); props.onChanged();
      } else setNotice({ ok: false, text: errText(r) });
    }).catch(function (e) { setBusy(''); setNotice({ ok: false, text: String(e && e.message || e) }); });
  }
  var failed = (st.packs || []).filter(function (p) { return p.error; });
  var ready = st.installed || 0;
  var total = st.total || 0;
  var syncMode = st.syncMode || 'auto';
  var modeLabel = syncMode === 'auto' ? '自动' : syncMode === 'manual' ? '手动' : '已冻结';
  var modeBtn = function (mode, label) {
    return React.createElement('button', {
      type: 'button', disabled: !!busy || syncMode === mode,
      onClick: function () { setMode(mode); },
      style: btn(syncMode === mode, { padding: '4px 10px', fontSize: 12 }),
    }, busy === 'mode:' + mode ? '切换中…' : label);
  };
  return React.createElement('div', { style: { border: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', borderRadius: 8, padding: '6px 10px', margin: '0 0 8px', fontSize: 12, background: 'var(--dsw-alias-bg-layer-2,#fafafb)' } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
      React.createElement('span', { style: { fontWeight: 700, color: ready === total && total ? '#1a7f37' : '#b45309' } }, '知识包 ' + ready + '/' + total),
      React.createElement('span', { style: CSS.hint }, '同步模式：' + modeLabel + (syncMode === 'auto' ? '（' + (st.autoSyncIntervalDays || 7) + ' 天一次）' : '') + '；按需加载，不常驻上下文'),
      React.createElement('button', {
        type: 'button', disabled: !!busy,
        onClick: function () { setShowAdmin(!showAdmin); },
        style: btn(false, { padding: '4px 10px', fontSize: 12 }),
      }, showAdmin ? '收起设置' : '同步设置'),
      React.createElement('div', { style: { flex: 1 } }),
      React.createElement('button', { type: 'button', disabled: !!busy || syncMode === 'frozen', onClick: syncAll, style: btn(false, { padding: '4px 12px', fontSize: 12 }) }, busy === 'sync' ? '同步中…' : '同步全部'),
      React.createElement('button', { type: 'button', disabled: !!busy, onClick: rebuild, style: btn(false, { padding: '4px 12px', fontSize: 12 }) }, busy === 'index' ? '重建中…' : '重建索引'),
      React.createElement('button', { type: 'button', onClick: function () { setExpanded(!expanded); }, style: btn(false, { padding: '4px 12px', fontSize: 12 }) }, expanded ? '收起列表' : '查看列表')),
    showAdmin ? React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5, paddingTop: 5, borderTop: '1px dashed var(--dsw-alias-border-l1,#e4e4e7)' } },
      modeBtn('auto', '自动'), modeBtn('manual', '手动'), modeBtn('frozen', '冻结')) : null,
    failed.length ? React.createElement('button', {
      type: 'button',
      onClick: function () { setExpanded(true); },
      style: { marginTop: 5, padding: 0, border: 0, background: 'transparent', color: '#d1242f', cursor: 'pointer', textAlign: 'left', fontSize: 12 },
    }, failed.length + ' 个知识包同步失败，点击查看原因') : null,
    notice ? React.createElement('div', { style: msgStyle(notice.ok), marginTop: 5 }, notice.text) : null,
    expanded ? React.createElement('div', { style: { marginTop: 6, maxHeight: 180, overflowY: 'auto', borderTop: '1px dashed var(--dsw-alias-border-l1,#e4e4e7)', paddingTop: 5 } },
      (st.packs || []).map(function (p) {
        return React.createElement('div', { key: p.id, style: { display: 'flex', gap: 6, padding: '2px 0' } },
          React.createElement('span', { style: { color: p.installed ? '#1a7f37' : '#b45309', flex: '0 0 46px' } }, p.installed ? '已安装' : '未安装'),
          React.createElement('span', { style: { fontWeight: 600, flex: '0 0 190px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.title || p.id),
          React.createElement('span', { title: p.backup || '', style: Object.assign({}, CSS.hint, { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }, p.error || p.license || (p.backup ? '旧目录已备份' : '')),
          p.error ? React.createElement('button', {
            type: 'button', disabled: !!busy, onClick: function () { syncOne(p.id); },
            style: btn(false, { padding: '2px 8px', fontSize: 11 }),
          }, busy === 'sync:' + p.id ? '重试中…' : '重试') : null);
      })) : null);
}

// ── Exploit-DB 状态卡（文件级组件，避免每次渲染重建导致状态重置）────────
function EdbCard(props) {
  var [st, setSt] = useState({ loading: true });
  var [syncing, setSyncing] = useState(false);
  // 下载结果与「说明」就地显示（原生 alert 会阻塞渲染进程，Agent 驱动的整页卡死）
  var [notice, setNotice] = useState(null);
  var [showHint, setShowHint] = useState(false);
  function status() {
    rpc(props.connection, 'edb-status', {}).then(function (r) { setSt(isOk(r) ? r.value : { error: errText(r) }); });
  }
  useEffect(status, []);
  function sync() {
    setSyncing(true);
    rpc(props.connection, 'edb-sync', {}).then(function (r) {
      setSyncing(false);
      if (r && r.ok && r.value && r.value.ok) {
        status();
        setNotice({ ok: true, text: 'Exploit-DB 元数据下载完成，索引 ' + r.value.rows + ' 条。' });
      } else {
        var msg = (r && r.value && r.value.results) ? r.value.results.map(function (x) { return x.name + ': ' + (x.ok ? 'OK' : x.error); }).join('；') : ((r && r.error && r.error.message) || '未知错误');
        setNotice({ ok: false, text: '下载失败：' + msg + '（需本机可访问 gitlab.com）' });
      }
    }).catch(function (e) { setSyncing(false); setNotice({ ok: false, text: '下载异常：' + String(e && e.message || e) }); });
  }
  var box = { border: '1px solid ' + (st.present ? '#bbf7d0' : 'var(--dsw-alias-border-l1,#e4e4e7)'), borderRadius: 8, padding: '6px 10px', margin: '0 0 8px', fontSize: 12, background: st.present ? '#f0fdf4' : 'var(--dsw-alias-bg-layer-2,#fafafb)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' };
  var tag = st.present
    ? React.createElement('span', { style: { color: '#1a7f37', fontWeight: 700 } }, 'Exploit-DB ' + st.rows + ' 条')
    : React.createElement('span', { style: { color: '#b45309', fontWeight: 700 } }, 'Exploit-DB 未接入');
  return React.createElement('div', { style: box },
    tag,
    st.present
      // 说清"只有元数据"：命中能按 EDB-ID/CVE 检索并给出 PoC 路径，但**正文不在**，
      // 点开会提示「文件不存在」。不写清楚用户会以为知识库坏了。
      ? React.createElement('span', null, '索引 ' + st.rows + ' 条（按 EDB-ID / CVE 定位 PoC 路径；此处只装元数据 CSV，PoC 正文不在——点开会提示「文件不存在」，要正文请把完整仓库放进 imports/exploitdb/）')
      : React.createElement('span', null, '接入后可离线按 EDB-ID 定位 PoC 文件。'),
    React.createElement('div', { style: { flex: 1 } }),
    st.present
      ? null
      : React.createElement('button', { type: 'button', disabled: syncing, onClick: sync, style: btn(false, { padding: '4px 12px', fontSize: 12 }) },
          syncing ? '下载中…（约 30MB）' : '下载官方索引'),
    React.createElement('button', { type: 'button', onClick: function () { setShowHint(!showHint); }, style: btn(false, { padding: '4px 12px', fontSize: 12 }) }, showHint ? '收起说明' : '说明'),
    notice ? React.createElement('div', { style: { flex: '1 0 100%', fontSize: 12, color: notice.ok ? '#1a7f37' : '#d1242f' } }, notice.text) : null,
    showHint ? React.createElement('div', { style: { flex: '1 0 100%', fontSize: 12, color: '#3f3f46', lineHeight: 1.6, whiteSpace: 'pre-wrap', borderTop: '1px dashed var(--dsw-alias-border-l1,#e4e4e7)', paddingTop: 6 } }, st.hint || '（暂无说明）') : null);
}

function Page(props) {
  var conn = props.connection;
  var [mode, setMode] = useState('pentest');
  var [activeFile, setActiveFile] = useState(null);
  var [statsV, setStatsV] = useState(null);
  var [reloadTick, setReloadTick] = useState(0);
  var [sourceTab, setSourceTab] = useState('patt');
  var [query, setQuery] = useState('');
  var [hits, setHits] = useState(null);
  var [searchBusy, setSearchBusy] = useState(false);
  var [searchErr, setSearchErr] = useState(null);
  var [showImport, setShowImport] = useState(false);
  // 新建文档的行内表单（原生 prompt 会阻塞渲染进程，Agent 驱动的整页卡死）
  var [showNew, setShowNew] = useState(false);
  var [newName, setNewName] = useState('my-note.md');
  var [newDir, setNewDir] = useState('');
  var [pageMsg, setPageMsg] = useState('');
  // 页面级提示（删除结果这类一次性反馈）。注意：本组件**没有** notice/setNotice ——
  // 那是 PackCard/EdbCard 内部的 state；在这里调 setNotice 会直接 ReferenceError
  // （实测：删除其实成功了，但处理函数抛错，提示永远不出现）。
  var [pageNotice, setPageNotice] = useState('');

  function loadStats() {
    rpc(conn, 'stats', {}).then(function (r) { if (isOk(r)) setStatsV(r.value); });
  }
  useEffect(loadStats, [reloadTick]);

  function openFile(f) { setActiveFile(f); }
  function onChanged() { setReloadTick(reloadTick + 1); }
	function onDeleted(noticeText) {
		setActiveFile(null);
		onChanged();
		setPageNotice(noticeText || '');
		if (noticeText) setTimeout(function () { setPageNotice(''); }, 4000);
	}
  function clearSearch() { setQuery(''); setHits(null); setSearchErr(null); }
  function runSearch() {
    var q = query.trim();
    if (!q || searchBusy) return;
    setSearchBusy(true); setSearchErr(null);
    rpc(conn, 'search', { query: q, mode: mode }).then(function (r) {
      setSearchBusy(false);
      if (isOk(r)) { setHits(r.value.hits || []); setSearchErr(null); }
      else { setHits([]); setSearchErr(errText(r)); }
    }).catch(function (e) { setSearchBusy(false); setHits([]); setSearchErr('检索失败：' + String((e && e.message) || e)); });
  }

  var statsLine = null;
  if (statsV) {
    statsLine = React.createElement('div', { style: { display: 'flex', gap: 10, margin: '2px 0 10px', fontSize: 12, color: '#6e6e73', flexWrap: 'wrap' } },
      React.createElement('span', null, '随包手册 ' + statsV.bundleMd + ' 篇'),
      React.createElement('span', null, '规则 ' + statsV.bundleRules + ' 条'),
      React.createElement('span', { style: { color: '#c2410c', fontWeight: 600 } }, '随包 PATT ' + statsV.patt + ' 篇'),
      React.createElement('span', null, '用户 ' + statsV.user + ' 篇'),
      React.createElement('span', null, '导入 ' + statsV.imports + ' 篇'),
      statsV.index ? React.createElement('span', null, '索引 ' + statsV.index.docs + ' 文档 / ' + statsV.index.chunks + ' chunks') : null,
      React.createElement('span', null, '合计 ' + statsV.total + ''));
  }

  var modeTabs = React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 4 } }, MODES.map(function (m) {
    var active = m.id === mode;
    return React.createElement('button', {
      key: m.id, type: 'button',
      style: { padding: '5px 12px', borderRadius: 6, border: '1px solid ' + (active ? '#2f81f7' : 'var(--dsw-alias-border-l1,#d9d9de)'), background: active ? '#2f81f7' : 'transparent', color: active ? '#fff' : 'var(--dsw-alias-label-primary,#1a1a1a)', fontSize: 12, fontWeight: active ? 600 : 400, cursor: 'pointer' },
      onClick: function () { setMode(m.id); setActiveFile(null); clearSearch(); },
    }, m.label);
  }));

  function sourceCount(id) {
    if (!statsV) return '';
    if (id === 'patt') return statsV.patt;
    if (id === 'bundle') return statsV.bundleMd;
    if (id === 'user') return statsV.user;
    if (id === 'import') return statsV.imports;
    return '';
  }
  var sourceTabs = React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
    SOURCE_TABS.map(function (s) {
      var active = sourceTab === s.id;
      var count = sourceCount(s.id);
      return React.createElement('button', {
        key: s.id, type: 'button',
        style: {
          padding: '5px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
          border: '1px solid ' + (active ? '#2f81f7' : 'var(--dsw-alias-border-l1,#d9d9de)'),
          background: active ? '#e8f1fe' : 'transparent',
          color: active ? '#1d4ed8' : 'var(--dsw-alias-label-primary,#1a1a1a)',
          fontWeight: active ? 600 : 400,
        },
        onClick: function () { setSourceTab(s.id); setActiveFile(null); clearSearch(); },
      }, s.title + (count === '' ? '' : ' ' + count) + (s.writable ? ' · 可写' : ''));
    }),
    React.createElement('div', { style: { flex: 1 } }),
    React.createElement('button', {
      type: 'button', style: btn(false, { padding: '5px 10px', fontSize: 12 }),
      onClick: function () { setShowImport(!showImport); },
    }, showImport ? '收起导入' : '添加来源'));

  var activeTab = SOURCE_TABS.filter(function (s) { return s.id === sourceTab; })[0] || SOURCE_TABS[0];
  var searchActive = hits !== null || searchBusy || searchErr !== null;
  var leftContent = searchActive
    ? React.createElement(SearchResults, { hits: hits || [], busy: searchBusy, error: searchErr, mode: mode, onOpen: openFile })
    : React.createElement(TreeSection, {
        connection: conn,
        source: activeTab.id,
        mode: mode,
        title: activeTab.title,
        writable: activeTab.writable,
        activeFile: activeFile,
        onOpen: openFile,
        reloadTick: reloadTick,
      });

  function createDoc() {
    var fileName = (newName || '').trim();
    if (!fileName) { setPageMsg('请先填文件名'); return; }
    var fname = fileName.toLowerCase().endsWith('.md') ? fileName : fileName + '.md';
    var dir = (newDir || '').trim().replace(/^\/+|\/+$/g, '');
    var rel = dir ? dir + '/' + fname : fname;
    setActiveFile({ source: 'user', mode: mode, path: rel, name: fname });
    rpc(conn, 'write', { source: 'user', mode: mode, path: rel, content: '# ' + fname.replace(/\.md$/, '') + '\n\n' }).then(function (r) {
      if (!isOk(r)) { setPageMsg('新建失败：' + errText(r)); return; }
      setPageMsg(''); setShowNew(false); setNewName('my-note.md'); setNewDir('');
      setReloadTick(reloadTick + 1);
    });
  }

  return React.createElement('div', null,
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
      React.createElement('div', { style: { fontSize: 14, fontWeight: 700 } }, '知识库'),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, modeTabs),
      React.createElement('button', { type: 'button', style: btn(false, { padding: '5px 10px', fontSize: 12 }), onClick: function () { setShowNew(!showNew); setPageMsg(''); } }, showNew ? '取消新建' : '+ 新建（用户层）')),
    showNew ? React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', margin: '6px 0 10px', fontSize: 12, flexWrap: 'wrap' } },
      '文件名：',
      React.createElement('input', { value: newName, onChange: function (e) { setNewName(e.target.value); }, placeholder: 'my-note.md', style: { padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', fontSize: 12 } }),
      '子目录（可空）：',
      React.createElement('input', { value: newDir, onChange: function (e) { setNewDir(e.target.value); }, placeholder: '如 web', style: { padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', fontSize: 12 } }),
      React.createElement('button', { type: 'button', style: btn(true, { padding: '4px 12px', fontSize: 12 }), onClick: createDoc }, '创建'),
      pageMsg ? React.createElement('span', { style: { color: '#d1242f' } }, pageMsg) : null) : null,
    statsLine,
    pageNotice ? React.createElement('div', { style: { margin: '6px 0 2px', fontSize: 12, color: '#1a7f37' } }, pageNotice) : null,
    React.createElement(PackCard, { connection: conn, reloadTick: reloadTick, onChanged: onChanged }),
    React.createElement(EdbCard, { connection: conn }),
    React.createElement('div', { style: { margin: '10px 0 8px' } },
      React.createElement(SearchBar, { query: query, busy: searchBusy, active: searchActive, onChange: setQuery, onRun: runSearch, onClear: clearSearch })),
    sourceTabs,
    // 没有打开文件时**不再**保留空的右半栏：旧布局是 `280px minmax(0,1fr)`，
    // 右半边一直是一句空态提示，把检索结果挤在 280px 里 —— 路径被截断成
    // `exploitdb/exploits/java/remote/5118…`，护网时扫一眼根本分不清命中。
    // 现在列表直接占满，提示降成列表下方一行小字。
    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr)', gap: 12, alignItems: 'stretch', marginTop: 8 } },
      React.createElement('div', { style: { display: activeFile ? 'none' : 'block', height: 420, minWidth: 0, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', borderRadius: 8, padding: 8, background: 'var(--dsw-alias-bg-layer-2,#fafafb)' } }, leftContent),
      React.createElement('div', { style: { display: activeFile ? 'block' : 'none', minWidth: 0, height: 'min(620px, 68vh)', overflowY: 'auto' } },
        React.createElement(Editor, { connection: conn, file: activeFile, onChanged: onChanged, onDeleted: onDeleted, onBack: function () { setActiveFile(null); } }))),
    activeFile ? null : React.createElement('div', { style: { marginTop: 6, fontSize: 11.5, color: '#9a9aa0', lineHeight: 1.6 } },
      '选择左侧文件即可预览/编辑；随包手册与随包 PATT 只读，用户 / 导入层可编辑、新建与删除。'),
    showImport ? React.createElement('div', { style: { marginTop: 12 } },
      React.createElement(ImportBox, { connection: conn, onChanged: onChanged })) : null);
}

function apply(ctx) {
  ctx.slots.inject('settings.section', function () {
    return ctx.slots.register({
      name: 'settings.section',
      id: 'knowledge-hub',
      order: 135,
      label: function () { return '知识库'; },
    }, function () {
      return React.createElement(Page, { connection: ctx.connection });
    });
  });
}

module.exports = { name: 'dsh-knowledge-hub-client', inject: ['slots', 'connection'], apply: apply };
return module.exports; } });
