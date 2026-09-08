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
];

function rpc(connection, endpoint, payload) {
  return connection.rpc.call(CHANNEL, endpoint, payload);
}
function isOk(r) { return !!(r && r.ok); }
function errText(r) { return (r && r.error) || '未知错误'; }

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
  return React.createElement('textarea', Object.assign({ style: Object.assign({ minHeight: 260, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12, lineHeight: 1.55, resize: 'vertical' }, CSS.field) }, rest, {
    onChange: typeof props.onChange === 'function'
      ? function (e) { props.onChange(e.target.value); }
      : undefined,
  }));
}

// ── Directory tree section ──────────────────────────────────────────────────
// Each source is shown as "category groups" — the top-level directories are
// rendered as bold category headers carrying a recursive file-count badge,
// so a large knowledge base (e.g. the bundled PATT chapters) reads as tidy
// grouped sections instead of one piled-up indented list.

function TreeRow(props) {
  var item = props.item;
  var isCat = item.kind === 'dir' && props.depth === 0;
  var indent = { paddingLeft: 8 + props.depth * 14, display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, borderRadius: 4, paddingTop: 2, paddingBottom: 2 };
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
  function renderChildren(children, depth, prefix) {
    if (!children) return [];
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
    React.createElement('div', { style: { marginTop: 2 } }, renderChildren(nodes, 0, '')),
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

  useEffect(function () {
    if (!props.file) { setContent(''); setDirty(false); return; }
    setBusy(true); setMsg(null);
    rpc(props.connection, 'read', { source: props.file.source, mode: props.file.mode, path: props.file.path }).then(function (r) {
      setBusy(false);
      if (isOk(r)) { setContent(r.value.content); setDirty(false); }
      else setMsg({ ok: false, text: errText(r) });
    });
  }, [props.file && props.file.source + '|' + props.file.mode + '|' + props.file.path]);

  if (!props.file) {
    return React.createElement('div', { style: { color: '#9a9aa0', fontSize: 13, padding: 40, textAlign: 'center', border: '1px dashed var(--dsw-alias-border-l1,#e4e4e7)', borderRadius: 8 } },
      '左侧选择文件。随包手册 / 随包 PATT 只读预览；用户 / 导入层可编辑、新建与删除。');
  }

  function save() {
    setBusy(true); setMsg(null);
    rpc(props.connection, 'write', { source: props.file.source, mode: props.file.mode, path: props.file.path, content: content }).then(function (r) {
      setBusy(false);
      if (isOk(r)) { setDirty(false); setMsg({ ok: true, text: '已保存（下一次检索/会话即生效）' }); props.onChanged(); }
      else setMsg({ ok: false, text: errText(r) });
    });
  }
  function remove() {
    if (!window.confirm('删除 ' + props.file.path + ' ？（仅删除 ' + meta.label + ' 层文件，不可恢复）')) return;
    setBusy(true); setMsg(null);
    rpc(props.connection, 'remove', { source: props.file.source, mode: props.file.mode, path: props.file.path }).then(function (r) {
      setBusy(false);
      if (isOk(r)) { props.onDeleted(); }
      else setMsg({ ok: false, text: errText(r) });
    });
  }

  var metaBadge = badge(meta.bg, meta.fg, meta.label + '层');
  var pathLine = React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
    React.createElement('span', { style: { fontSize: 12, color: '#3f3f46', wordBreak: 'break-all' } }, props.file.mode ? props.file.mode + '/' : '', props.file.path),
    metaBadge,
    writable && dirty ? React.createElement('span', { style: { fontSize: 12, color: '#9a6700' } }, '（未保存）') : null);

  return React.createElement('div', null,
    pathLine,
    React.createElement('div', { style: { marginTop: 8 } },
      React.createElement(TextArea, { value: content, readOnly: !writable, disabled: busy, spellCheck: false, onChange: function (v) { setContent(v); setDirty(true); } })),
    React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
      writable ? React.createElement('button', { type: 'button', disabled: busy, style: btn(true), onClick: save }, busy ? '保存中…' : '保存（写用户层）') : null,
      writable ? React.createElement('button', { type: 'button', disabled: busy, style: btn(false), onClick: remove }, '删除') : null,
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

function SearchBox(props) {
  var [query, setQuery] = useState('');
  var [busy, setBusy] = useState(false);
  var [hits, setHits] = useState(null);
  var [err, setErr] = useState(null);
  useEffect(function () { setHits(null); setErr(null); }, [props.mode]);
  function run() {
    if (!query.trim() || busy) return;
    setBusy(true); setErr(null);
    rpc(props.connection, 'search', { query: query.trim(), mode: props.mode }).then(function (r) {
      setBusy(false);
      if (isOk(r)) { setHits(r.value.hits); setErr(null); }
      else { setHits([]); setErr(errText(r)); }
    });
  }
  var rows = null;
  if (hits) {
    rows = err
      ? React.createElement('div', { style: { color: '#d1242f', fontSize: 12, padding: 6 } }, '检索失败：' + err)
      : hits.length === 0
        ? React.createElement('div', { style: { color: '#9a9aa0', fontSize: 12, padding: 6 } }, '无命中')
        : React.createElement('div', null, hits.map(function (h, i) {
            var m = SOURCE_META[h.source] || SOURCE_META.bundle;
            return React.createElement('div', {
              key: i,
              style: { display: 'flex', alignItems: 'flex-start', gap: 6, padding: '3px 4px', borderRadius: 4, cursor: 'pointer', fontSize: 12 },
              onMouseEnter: function (e) { e.currentTarget.style.background = 'var(--dsw-alias-bg-fill,#f0f2f5)'; },
              onMouseLeave: function (e) { e.currentTarget.style.background = 'transparent'; },
              onClick: function () { props.onOpen({ source: h.source, mode: h.mode || props.mode, path: h.path, name: h.path.split('/').pop() }); },
            },
              badge(m.bg, m.fg, m.label),
              React.createElement('span', { style: { color: '#3f3f46', whiteSpace: 'nowrap' } }, h.mode ? h.mode + '/' : '', h.path, h.line ? ':' + h.line : ''),
              React.createElement('span', { style: { color: '#9a9aa0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 } }, h.preview || ''));
          }));
  }
  return React.createElement('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', paddingTop: 12 } },
    React.createElement('div', { style: CSS.groupTitle }, '检索测试'),
    React.createElement('div', { style: Object.assign({}, CSS.hint, { marginBottom: 6 }) },
      '关键词定位（包内 + 用户 + 导入三层；先定位到文件，点开读原文；Enter 或点检索）。'),
    React.createElement('div', { style: { display: 'flex', gap: 8 } },
      React.createElement('div', { style: { flex: 1 } }, React.createElement(Input, { value: query, placeholder: '如 fastjson / jwt / order-by 盲注', onChange: setQuery, onKeyDown: function (e) { if (e.key === 'Enter') run(); } })),
      React.createElement('button', { type: 'button', disabled: busy, style: btn(true), onClick: run }, busy ? '检索中…' : '检索')),
    rows ? React.createElement('div', { style: { marginTop: 6, maxHeight: 180, overflowY: 'auto' } }, rows) : null);
}

// ── Page ────────────────────────────────────────────────────────────────────

// ── Exploit-DB 状态卡（文件级组件，避免每次渲染重建导致状态重置）────────
function EdbCard(props) {
  var [st, setSt] = useState({ loading: true });
  var [syncing, setSyncing] = useState(false);
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
        window.alert('Exploit-DB 元数据下载完成，索引 ' + r.value.rows + ' 条。');
      } else {
        var msg = (r && r.value && r.value.results) ? r.value.results.map(function (x) { return x.name + ': ' + (x.ok ? 'OK' : x.error); }).join('；') : ((r && r.error && r.error.message) || '未知错误');
        window.alert('下载失败：' + msg + '\n（需本机可访问 gitlab.com）');
      }
    }).catch(function (e) { setSyncing(false); window.alert('下载异常：' + String(e && e.message || e)); });
  }
  var box = { border: '1px solid ' + (st.present ? '#bbf7d0' : 'var(--dsw-alias-border-l1,#e4e4e7)'), borderRadius: 8, padding: '6px 10px', margin: '0 0 8px', fontSize: 12, background: st.present ? '#f0fdf4' : 'var(--dsw-alias-bg-layer-2,#fafafb)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' };
  var tag = st.present
    ? React.createElement('span', { style: { color: '#1a7f37', fontWeight: 700 } }, 'Exploit-DB ' + st.rows + ' 条')
    : React.createElement('span', { style: { color: '#b45309', fontWeight: 700 } }, 'Exploit-DB 未接入');
  return React.createElement('div', { style: box },
    tag,
    st.present
      ? React.createElement('span', null, '索引 ' + st.rows + ' 条（按 EDB-ID 定位 PoC；完整描述检索需本地完整仓库或联网）')
      : React.createElement('span', null, '接入后可离线按 EDB-ID 定位 PoC 文件。'),
    React.createElement('div', { style: { flex: 1 } }),
    st.present
      ? null
      : React.createElement('button', { type: 'button', disabled: syncing, onClick: sync, style: btn(false, { padding: '4px 12px', fontSize: 12 }) },
          syncing ? '下载中…（约 30MB）' : '下载官方索引'),
    React.createElement('button', { type: 'button', onClick: function () { window.alert(st.hint || ''); }, style: btn(false, { padding: '4px 12px', fontSize: 12 }) }, '说明'));
}

function Page(props) {
  var conn = props.connection;
  var [mode, setMode] = useState('pentest');
  var [activeFile, setActiveFile] = useState(null);
  var [statsV, setStatsV] = useState(null);
  var [reloadTick, setReloadTick] = useState(0);

  function loadStats() {
    rpc(conn, 'stats', {}).then(function (r) { if (isOk(r)) setStatsV(r.value); });
  }
  useEffect(loadStats, []);
  useEffect(loadStats, [reloadTick]);

  function openFile(f) { setActiveFile(f); }
  function onChanged() { setReloadTick(reloadTick + 1); }
  function onDeleted() { setActiveFile(null); onChanged(); }

  var statsLine = null;
  if (statsV) {
    statsLine = React.createElement('div', { style: { display: 'flex', gap: 10, margin: '2px 0 10px', fontSize: 12, color: '#6e6e73', flexWrap: 'wrap' } },
      React.createElement('span', null, '随包手册 ' + statsV.bundleMd + ' 篇'),
      React.createElement('span', null, '规则 ' + statsV.bundleRules + ' 条'),
      React.createElement('span', { style: { color: '#c2410c', fontWeight: 600 } }, '随包 PATT ' + statsV.patt + ' 篇'),
      React.createElement('span', null, '用户 ' + statsV.user + ' 篇'),
      React.createElement('span', null, '导入 ' + statsV.imports + ' 篇'),
      React.createElement('span', null, '合计 ' + statsV.total + ''));
  }

  var modeTabs = React.createElement('div', { style: { display: 'flex', gap: 6, marginBottom: 4 } }, MODES.map(function (m) {
    var active = m.id === mode;
    return React.createElement('button', {
      key: m.id, type: 'button',
      style: { padding: '5px 12px', borderRadius: 6, border: '1px solid ' + (active ? '#2f81f7' : 'var(--dsw-alias-border-l1,#d9d9de)'), background: active ? '#2f81f7' : 'transparent', color: active ? '#fff' : 'var(--dsw-alias-label-primary,#1a1a1a)', fontSize: 12, fontWeight: active ? 600 : 400, cursor: 'pointer' },
      onClick: function () { setMode(m.id); setActiveFile(null); },
    }, m.label);
  }));

  function newDoc() {
    var fileName = window.prompt('新建文件名（放用户层 ' + mode + ' 根目录，.md 自动补）', 'my-note.md');
    if (!fileName) return;
    var fname = fileName.trim().toLowerCase().endsWith('.md') ? fileName.trim() : fileName.trim() + '.md';
    var pathName = window.prompt('可选的子目录（如 web，留空放根目录）', '');
    var dir = (pathName || '').trim().replace(/^\/+|\/+$/g, '');
    var rel = dir ? dir + '/' + fname : fname;
    setActiveFile({ source: 'user', mode: mode, path: rel, name: fname });
    rpc(conn, 'write', { source: 'user', mode: mode, path: rel, content: '# ' + fname.replace(/\.md$/, '') + '\n\n' }).then(function (r) {
      if (!isOk(r)) { window.alert('新建失败：' + errText(r)); return; }
      setReloadTick(reloadTick + 1);
    });
  }

  return React.createElement('div', null,
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
      React.createElement('div', { style: { fontSize: 14, fontWeight: 700 } }, '知识库'),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, modeTabs),
      React.createElement('button', { type: 'button', style: btn(false, { padding: '5px 10px', fontSize: 12 }), onClick: newDoc }, '+ 新建（用户层）')),
    statsLine,
    React.createElement(EdbCard, { connection: conn }),
    React.createElement('div', { style: { display: 'flex', gap: 16, alignItems: 'flex-start' } },
      React.createElement('div', { style: { flex: '0 0 330px', minWidth: 260, maxHeight: 580, overflowY: 'auto', borderRight: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', paddingRight: 10 } },
        React.createElement(TreeSection, { connection: conn, source: 'patt', mode: mode, title: '随包 PATT', writable: false, activeFile: activeFile, onOpen: openFile, reloadTick: reloadTick }),
        React.createElement('hr', { style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', margin: '8px 0' } }),
        React.createElement(TreeSection, { connection: conn, source: 'bundle', mode: mode, title: '随包手册', writable: false, activeFile: activeFile, onOpen: openFile, reloadTick: reloadTick }),
        React.createElement('hr', { style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', margin: '8px 0' } }),
        React.createElement(TreeSection, { connection: conn, source: 'user', mode: mode, title: '用户积累', writable: true, activeFile: activeFile, onOpen: openFile, reloadTick: reloadTick }),
        React.createElement('hr', { style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', margin: '8px 0' } }),
        React.createElement(TreeSection, { connection: conn, source: 'import', mode: mode, title: '导入知识源', writable: true, activeFile: activeFile, onOpen: openFile, reloadTick: reloadTick })),
      React.createElement('div', { style: { flex: 1, minWidth: 0 } },
        React.createElement(Editor, { connection: conn, file: activeFile, onChanged: onChanged, onDeleted: onDeleted }))),
    React.createElement('div', { style: { marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 } },
      React.createElement(SearchBox, { connection: conn, mode: mode, onOpen: openFile }),
      React.createElement(ImportBox, { connection: conn, onChanged: onChanged })));
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
