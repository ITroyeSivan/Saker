// dsh-sec-config — web client.
// Registers a "安全配置" settings section: local tool paths, service endpoints
// (Burp/Yakit), DNSLog, API keys, and an operator password-change form. All
// settings edits go through the plugin's loopback RPC; password change POSTs
// to /auth/change-password (master-key authorized).
window.__ModuleLoader__.load({ id: '@dsh-external/dsh-sec-config', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict';
var React = require('react');
var useState = React.useState, useEffect = React.useEffect;

var CHANNEL = '/dsh-sec-config';

// Preset tool catalog (mirror of host TOOL_PRESETS — fallback until the RPC
// answers). Custom tools (arbitrary keys) are managed alongside them.
var CATEGORY_ORDER = ['信息收集', '漏洞扫描', '目录与接口', '注入与利用', '令牌与认证'];
var FALLBACK_PRESETS = [
  { key: 'subfinder', label: 'Subfinder', category: '信息收集' },
  { key: 'httpx', label: 'Httpx', category: '信息收集' },
  { key: 'nmap', label: 'Nmap', category: '信息收集' },
  { key: 'nuclei', label: 'Nuclei', category: '漏洞扫描' },
  { key: 'afrog', label: 'Afrog', category: '漏洞扫描' },
  { key: 'dirsearch', label: 'Dirsearch', category: '目录与接口' },
  { key: 'katana', label: 'Katana', category: '目录与接口' },
  { key: 'ffuf', label: 'Ffuf', category: '目录与接口' },
  { key: 'sqlmap', label: 'SQLMap', category: '注入与利用' },
  { key: 'jwt_tool', label: 'JWT Tool', category: '令牌与认证' },
  { key: 'fscan', label: 'Fscan', category: '内网与横向' },
  { key: 'chisel', label: 'Chisel', category: '内网与横向' },
  { key: 'frp', label: 'Frp', category: '内网与横向' },
  { key: 'impacket', label: 'Impacket', category: '内网与横向' },
  { key: 'ladon', label: 'Ladon', category: '内网与横向' },
  { key: 'kerbrute', label: 'Kerbrute', category: '内网与横向' },
  { key: 'mimikatz', label: 'Mimikatz', category: '内网与横向' },
  { key: 'bloodhound', label: 'BloodHound', category: '内网与横向' },
];
var TOOL_NAME_RE = /^[A-Za-z0-9_]+$/;
var PRESET_LABEL = { key: 'preset', label: '预设', bg: '#e4e4e7', fg: '#6e6e73' };
var CUSTOM_LABEL = { key: 'custom', label: '自定义', bg: '#dbeafe', fg: '#1d4ed8' };

function rpc(connection, endpoint, payload) {
  return connection.rpc.call(CHANNEL, endpoint, payload);
}

function fieldStyle() {
  return { display: 'block', width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1, #d9d9de)', background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-label-primary, #1a1a1a)', fontSize: 13, boxSizing: 'border-box' };
}
function labelStyle() { return { display: 'block', margin: '10px 0 4px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #6e6e73)' }; }
function groupStyle() { return { marginBottom: 18 }; }
function groupTitleStyle() { return { fontSize: 13, fontWeight: 600, margin: '0 0 4px', color: 'var(--dsw-alias-label-primary, #1a1a1a)' }; }
function btnStyle(primary) { return { padding: '8px 16px', borderRadius: 6, border: '1px solid ' + (primary ? 'transparent' : 'var(--dsw-alias-border-l1,#d9d9de)'), background: primary ? '#2f81f7' : 'transparent', color: primary ? '#fff' : 'var(--dsw-alias-label-primary,#1a1a1a)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }; }
function msgStyle(ok) { return { marginTop: 8, fontSize: 12, color: ok ? '#1a7f37' : '#d1242f' }; }

function Input(props) {
  return React.createElement('input', { type: props.type || 'text', value: props.value, placeholder: props.placeholder, style: fieldStyle(), onChange: function (e) { props.onChange(e.target.value); } });
}

function Group(props) {
  return React.createElement('div', { style: groupStyle() },
    React.createElement('div', { style: groupTitleStyle() }, props.title),
    props.children);
}

// ── Tool library section ────────────────────────────────────────────────────
// Category groups of preset tools (fill a path to "add" it), an operator-custom
// add form, and per-row remove. All edits stay local until 保存配置 commits.
//
// 路径获取：不再弹系统对话框（浏览器拿不到绝对路径；宿主弹窗在无交互桌面/远程
// 场景会不可见甚至卡死）。改为「自动探测」——宿主静默扫描候选根（已配工具父
// 目录 + 可选 scanRoots），把每个工具按文件名匹配出的候选路径渲染成 chips，
// 点一下即填入。与技能上传一样点选即得、永不弹窗。

// ============ 工具库 v2（目录即库）：默认空 → 选根目录一键探测自动分类导入 ============
var BASE_CATEGORIES = ['信息收集', '漏洞扫描', '目录与接口', '注入与利用', '令牌与认证', '内网与横向', '其他'];
var CAT_FALLBACK = '其他';

function sanitizeKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}
function prettyName(stem) {
  return String(stem || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }).trim();
}
function uniqueKey(baseKey, existing) {
  var k = sanitizeKey(baseKey) || 'tool';
  var cand = k; var n = 2;
  while (existing.indexOf(cand) >= 0) { cand = k + '_' + n; n++; }
  return cand;
}
function catListOf(cfg) {
  var extras = Array.isArray(cfg && cfg.categories) ? cfg.categories.filter(function (c) { return BASE_CATEGORIES.indexOf(c) < 0; }) : [];
  var all = BASE_CATEGORIES.slice();
  extras.forEach(function (c) { if (all.indexOf(c) < 0) all.push(c); });
  return all;
}
function presetLabelOf(key) {
  var hit = FALLBACK_PRESETS.filter(function (t) { return t.key === key; })[0];
  return hit ? hit.label : null;
}
function rowBtnStyle(extra) {
  return Object.assign({ padding: '3px 9px', borderRadius: 6, fontSize: 11, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: 'transparent', color: 'var(--dsw-alias-label-primary,#1a1a1a)' }, extra || {});
}
var miniHint = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#6e6e73)' };

function ToolLibrary(props) {
  var cfg = props.value || {};
  var entries = Array.isArray(cfg.entries) ? cfg.entries : [];
  var roots = Array.isArray(cfg.roots) ? cfg.roots : [];
  var cats = catListOf(cfg);
  var state = React.useState({ rootInput: '', scanning: false, msg: null, preview: null, manual: { cat: CAT_FALLBACK, name: '', path: '' }, newCat: '' });
  var S = state[0]; var set = state[1];
  var up = function (patch) { set(Object.assign({}, S, patch)); };
  var patchCfg = function (p) { props.onChange && props.onChange(p); };

  var setRootInput = function (v) { up({ rootInput: v }); };
  var addRoot = function () {
    var r = S.rootInput.trim();
    if (!r || roots.indexOf(r) >= 0) { if (r) up({ rootInput: '' }); return; }
    patchCfg({ roots: roots.concat([r]) });
    up({ rootInput: '' });
  };
  var removeRoot = function (r) { patchCfg({ roots: roots.filter(function (x) { return x !== r; }) }); };

  var doScan = function () {
    if (roots.length === 0) { up({ msg: '请先在上方添加工具根目录（可多个）' }); return; }
    up({ scanning: true, msg: null });
    rpc(props.connection, 'catalog/scan', { roots: roots }).then(function (res) {
      if (!res || !res.ok || !res.value || !Array.isArray(res.value.files)) {
        up({ scanning: false, msg: '探测失败：' + ((res && res.error && res.error.message) || '未知错误') });
        return;
      }
      var picks = {};
      res.value.files.forEach(function (f) { picks[f.path] = true; });
      up({ scanning: false, preview: { files: res.value.files, picks: picks, catOverride: {} } });
    }).catch(function () { up({ scanning: false, msg: '探测请求失败' }); });
  };
  var togglePick = function (path) {
    var pv = S.preview;
    var picks = Object.assign({}, pv.picks);
    if (picks[path]) delete picks[path]; else picks[path] = true;
    up({ preview: Object.assign({}, pv, { picks: picks }) });
  };
  var setFileCat = function (path, cat) {
    var pv = S.preview;
    var co = Object.assign({}, pv.catOverride); co[path] = cat;
    up({ preview: Object.assign({}, pv, { catOverride: co }) });
  };
  var importSelection = function () {
    var pv = S.preview;
    if (!pv || !pv.files || !pv.files.length) return;
    var existingPaths = {}; var existingKeys = {};
    entries.forEach(function (e) { existingPaths[e.path] = true; existingKeys[e.key] = true; });
    var added = []; var dup = 0;
    pv.files.forEach(function (f) {
      if (!pv.picks[f.path]) return;
      if (existingPaths[f.path]) { dup++; return; }
      var used = Object.keys(existingKeys).concat(added.map(function (a) { return a.key; }));
      var key = f.presetKey && !existingKeys[f.presetKey] ? f.presetKey : uniqueKey(f.name, used);
      var name = f.presetKey ? (presetLabelOf(f.presetKey) || f.presetKey) : prettyName(sanitizeKey(f.name).replace(/\.(exe|py|ps1|jar|bat|cmd|sh|pl)$/i, ''));
      existingKeys[key] = true;
      added.push({ key: key, name: name, path: f.path, category: pv.catOverride[f.path] || f.category || CAT_FALLBACK });
    });
    if (added.length === 0) {
      up({ msg: dup > 0 ? '所选均已在库（跳过重复 ' + dup + ' 项）' : '没有勾选可导入的条目' });
      return;
    }
    patchCfg({ entries: entries.concat(added) });
    up({ preview: null, msg: '已导入 ' + added.length + ' 项' + (dup ? '（跳过重复 ' + dup + '）' : '') + '，点「保存配置」生效' });
  };
  var importOne = function (f) {
    if (entries.some(function (e) { return e.path === f.path; })) { up({ msg: '该工具已在库中' }); return; }
    var used = entries.map(function (e) { return e.key; });
    var key = f.presetKey && used.indexOf(f.presetKey) < 0 ? f.presetKey : uniqueKey(f.name, used);
    var name = f.presetKey ? (presetLabelOf(f.presetKey) || f.presetKey) : prettyName(sanitizeKey(f.name).replace(/\.(exe|py|ps1|jar|bat|cmd|sh|pl)$/i, ''));
    patchCfg({ entries: entries.concat([{ key: key, name: name, path: f.path, category: f.category || CAT_FALLBACK }]) });
    var pv = S.preview;
    if (pv) up({ preview: Object.assign({}, pv, { files: pv.files.filter(function (x) { return x.path !== f.path; }) }), msg: '已导入 ' + name });
  };

  var removeEntry = function (key) { patchCfg({ entries: entries.filter(function (e) { return e.key !== key; }) }); };
  var setEntryCat = function (key, cat) { patchCfg({ entries: entries.map(function (e) { return e.key === key ? Object.assign({}, e, { category: cat }) : e; }) }); };

  var manualAdd = function () {
    var name = S.manual.name.trim(); var p = S.manual.path.trim();
    if (!TOOL_NAME_RE.test(name)) { up({ msg: '工具名只允许字母/数字/下划线' }); return; }
    if (!p) { up({ msg: '请填写工具绝对路径' }); return; }
    if (entries.some(function (e) { return e.path === p || e.key === name; })) { up({ msg: '该路径或名称已在库中' }); return; }
    patchCfg({ entries: entries.concat([{ key: name, name: name, path: p, category: S.manual.cat || CAT_FALLBACK }]) });
    up({ manual: { cat: S.manual.cat || CAT_FALLBACK, name: '', path: '' }, msg: '已加入，点「保存配置」生效' });
  };
  var addCategory = function () {
    var c = S.newCat.trim();
    if (!c || cats.indexOf(c) >= 0) { if (c) up({ newCat: '' }); return; }
    patchCfg({ categories: (cfg.categories || []).concat([c]) });
    up({ newCat: '' });
  };
  var removeCategory = function (c) {
    if (BASE_CATEGORIES.indexOf(c) >= 0) return;
    patchCfg({
      categories: (cfg.categories || []).filter(function (x) { return x !== c; }),
      entries: entries.map(function (e) { return e.category === c ? Object.assign({}, e, { category: CAT_FALLBACK }) : e; }),
    });
  };

  var grouped = {};
  cats.forEach(function (c) { grouped[c] = []; });
  entries.forEach(function (e) { var c = cats.indexOf(e.category) >= 0 ? e.category : CAT_FALLBACK; (grouped[c] = grouped[c] || []).push(e); });

  var el = React.createElement;
  var children = [];
  // 1) 目录格式提示
  children.push(el('div', { key: 'hint', style: { fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', marginBottom: 10, padding: '10px 12px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2,#f6f6f7)', border: '1px dashed var(--dsw-alias-border-l1,#d9d9de)' } },
    el('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary,#1a1a1a)', marginBottom: 4 } }, '推荐的工具目录格式'),
    el('div', null, '默认工具库为空；添加「工具根目录」（可多个）后一键探测，按目录自动分类导入。推荐结构：'),
    el('code', { style: { background: 'rgba(127,127,127,.12)', padding: '1px 5px', borderRadius: 4 } }, '工具根/05-内网与域渗透/Kerbrute/kerbrute_windows_amd64.exe'),
    el('div', null, '分类目录名不限，按名称自动归类（内网/漏洞/注入/目录…）。扁平目录也可，导入后逐项改分类；分散在不同位置的工具用「按分类手动导入」。')));
  // 2) 根目录编辑 + 探测
  var rootRow = [];
  rootRow.push(el(Input, { key: 'ri', value: S.rootInput, placeholder: '工具根目录，如 E:\\...\\Tools（可添加多个）', onChange: setRootInput }));
  rootRow.push(el('button', { key: 'add', type: 'button', style: rowBtnStyle(), onClick: addRoot }, '添加目录'));
  rootRow.push(el('button', { key: 'scan', type: 'button', disabled: S.scanning, style: rowBtnStyle({ borderColor: '#2f81f7', color: '#2f81f7' }), onClick: doScan }, S.scanning ? '探测中…' : '探测并自动导入'));
  children.push(el('div', { key: 'roots', style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 6 } }, rootRow));
  if (roots.length > 0) {
    children.push(el('div', { key: 'rootlist', style: Object.assign({}, miniHint, { marginBottom: 8 }) }, '工具根目录：' + roots.map(function (r) {
      return el('span', { key: r, style: { marginRight: 8 } }, r + el('button', { type: 'button', title: '移出该目录', style: { border: 'none', background: 'transparent', color: '#d1242f', cursor: 'pointer', marginLeft: 2 }, onClick: function () { removeRoot(r); } }, '×'));
    })));
  }
  // 3) 探测预览
  if (S.preview && S.preview.files) {
    var pv = S.preview;
    var prevKids = [];
    prevKids.push(el('div', { key: 'meta', style: Object.assign({}, miniHint, { marginBottom: 4 }) }, '探测到 ' + pv.files.length + ' 个可导入工具（★=内置预设识别）：'));
    prevKids.push(el('button', { key: 'all', type: 'button', style: rowBtnStyle(), onClick: function () { var picks = {}; pv.files.forEach(function (f) { picks[f.path] = true; }); up({ preview: Object.assign({}, pv, { picks: picks }) }); } }, '全选'));
    prevKids.push(el('button', { key: 'none', type: 'button', style: rowBtnStyle(), onClick: function () { up({ preview: Object.assign({}, pv, { picks: {} }) }); } }, '清空'));
    pv.files.forEach(function (f) {
      prevKids.push(el('div', { key: f.path, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', fontSize: 12 } },
        el('input', { type: 'checkbox', checked: !!pv.picks[f.path], onChange: function () { togglePick(f.path); } }),
        el('select', { value: pv.catOverride[f.path] || f.category || CAT_FALLBACK, style: { fontSize: 11, maxWidth: 130 }, onChange: function (e) { setFileCat(f.path, e.target.value); } }, cats.map(function (c) { return el('option', { key: c, value: c }, c); })),
        el('span', { style: { flex: '0 0 110px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (f.presetKey ? '★ ' + (presetLabelOf(f.presetKey) || f.presetKey) : f.name)),
        el('span', { style: { flex: 1, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.path),
        el('button', { type: 'button', style: rowBtnStyle(), onClick: function () { importOne(f); } }, '单导')));
    });
    prevKids.push(el('div', { key: 'go', style: { marginTop: 6 } },
      el('button', { type: 'button', style: rowBtnStyle({ background: '#2f81f7', color: '#fff', borderColor: '#2f81f7' }), onClick: importSelection }, '导入勾选项')));
    children.push(el('div', { key: 'preview', style: { border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', borderRadius: 8, margin: '4px 0 8px', padding: 8, maxHeight: 300, overflow: 'auto' } }, prevKids));
  }
  // 4) 分类树
  cats.forEach(function (c) {
    var rows = grouped[c] || [];
    var kids = rows.length === 0
      ? [el('div', { key: 'empty', style: miniHint }, '空——可手动导入，或扫描自动归入')]
      : rows.map(function (e) {
          return el('div', { key: e.key, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 13 } },
            el('span', { style: { flex: '0 0 150px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, e.name || e.key),
            el('span', { style: { flex: 1, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 } }, e.path),
            el('select', { value: e.category, style: { fontSize: 11 }, onChange: function (ev) { setEntryCat(e.key, ev.target.value); } }, cats.map(function (cc) { return el('option', { key: cc, value: cc }, cc); })),
            el('button', { type: 'button', style: rowBtnStyle({ color: '#d1242f' }), onClick: function () { removeEntry(e.key); } }, '移除'));
        });
    children.push(el(Group, { key: 'g:' + c, title: c + '（' + rows.length + '）' }, kids));
  });
  // 5) 手动导入
  var m = S.manual;
  children.push(el('div', { key: 'manual', style: { borderTop: '1px solid var(--dsw-alias-border-l1,#d9d9de)', marginTop: 10, paddingTop: 8 } },
    el('div', { style: { fontWeight: 600, fontSize: 13, margin: '6px 0' } }, '按分类手动导入（工具分散在不同目录/已单独安装时用这个）'),
    el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } },
      el('select', { value: m.cat, style: { fontSize: 12, maxWidth: 150 }, onChange: function (ev) { up({ manual: Object.assign({}, m, { cat: ev.target.value }) }); } }, cats.map(function (c) { return el('option', { key: c, value: c }, c); })),
      el('div', { style: { width: 170 } }, el(Input, { value: m.name, placeholder: '工具名（字母数字下划线）', onChange: function (v) { up({ manual: Object.assign({}, m, { name: v }) }); } })),
      el('div', { style: { flex: 1, minWidth: 220 } }, el(Input, { value: m.path, placeholder: '工具绝对路径（exe/py/ps1/jar…）', onChange: function (v) { up({ manual: Object.assign({}, m, { path: v }) }); } })),
      el('button', { type: 'button', style: rowBtnStyle({ borderColor: '#2f81f7', color: '#2f81f7' }), onClick: manualAdd }, '手动导入'))));
  // 6) 分类管理
  var catKids = cats.map(function (c) {
    var builtin = BASE_CATEGORIES.indexOf(c) >= 0;
    return el('span', { key: c, style: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999, fontSize: 12, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)' } },
      c,
      builtin ? null : el('button', { type: 'button', title: '删除分类（工具移回「其他」）', style: { border: 'none', background: 'transparent', color: '#d1242f', cursor: 'pointer', fontSize: 12, padding: 0 }, onClick: function () { removeCategory(c); } }, '×'));
  });
  catKids.push(el(Input, { key: 'inp', value: S.newCat, placeholder: '自定义分类名', onChange: function (v) { up({ newCat: v }); } }));
  catKids.push(el('button', { key: 'addc', type: 'button', style: rowBtnStyle(), onClick: addCategory }, '添加分类'));
  children.push(el('div', { key: 'cats', style: { borderTop: '1px solid var(--dsw-alias-border-l1,#d9d9de)', marginTop: 10, paddingTop: 8 } },
    el('div', { style: { fontWeight: 600, fontSize: 13, margin: '6px 0' } }, '分类管理'),
    el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } }, catKids)));
  if (S.msg) children.push(el('div', { key: 'msg', style: msgStyle(true) }, S.msg));
  return el('div', null, children);
}
function hintStyle() { return { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #6e6e73)', marginBottom: 6, lineHeight: 1.6 }; }

function ConfigForm(props) {
  var v = props.value || {};
  var tools = v.tools || {}, services = v.services || {}, dnslog = v.dnslog || {}, apiKeys = v.apiKeys || {};
  var [busy, setBusy] = useState(false);
  var [msg, setMsg] = useState('');
  var [mountStatus, setMountStatus] = useState({ burp: null, yakit: null });
  var [mountingName, setMountingName] = useState(null);

  function setPath(path, val) {
    var next = JSON.parse(JSON.stringify(v));
    var cursor = next;
    for (var i = 0; i < path.length - 1; i++) { if (!cursor[path[i]]) cursor[path[i]] = {}; cursor = cursor[path[i]]; }
    cursor[path[path.length - 1]] = val;
    props.onChange(next);
  }

  // Read mcp-studio live status (state + tool count per server) so the page can
  // show a real badge next to each service URL instead of a static placeholder.
  function refreshStatus() {
    var conn = props.connection;
    if (!conn || !conn.rpc || !conn.rpc.call) return;
    conn.rpc.call('/dsh-mcp-studio', 'status', {}).then(function (res) {
      if (!res || !res.ok || !res.value || !Array.isArray(res.value.servers)) return;
      var next = { burp: null, yakit: null };
      for (var i = 0; i < res.value.servers.length; i++) {
        var s = res.value.servers[i];
        if (s && (s.name === 'burp' || s.name === 'yakit')) {
          next[s.name] = { state: s.state, toolCount: s.toolCount || 0, error: s.error || null };
        }
      }
      setMountStatus(next);
    }).catch(function () { /* silent: mcp-studio may not be loaded yet */ });
  }
  useEffect(refreshStatus, []);

  // Per-row immediate mount. Saves the field first (so host bridge has the new
  // URL), then calls host mount-services which writes mcp-studio.servers.
  function mountOne(name) {
    var nextServices = JSON.parse(JSON.stringify(v.services || {}));
    if (name === 'burp') nextServices.burpUrl = (v.services && v.services.burpUrl) || '';
    if (name === 'yakit') nextServices.yakitUrl = (v.services && v.services.yakitUrl) || '';
    setMountingName(name);
    rpc(props.connection, 'settings/mutate', { ops: [{ op: 'set', path: ['services'], value: nextServices }] })
      .then(function (r) { return r && r.ok ? rpc(props.connection, 'mount-services', {}) : null; })
      .then(function () {
        setMountingName(null);
        setTimeout(refreshStatus, 600);
        setTimeout(refreshStatus, 1800);
      })
      .catch(function () { setMountingName(null); });
  }

  function save() {
    setBusy(true); setMsg('');
    // API 密钥（DeepSeek Key）已统一在「平台设置 → 模型/服务」中维护；本页面
    // 不再读写 apiKeys，避免双源/覆盖。
    // 工具库 v2 为真源：entries/roots/categories 一起持久化；tools 映射由条目派生，
    // 供 shell 环境变量（DSH_TOOL_*，preset key）与既有读取方继续工作。
    var libTools = {};
    (v.entries || []).forEach(function (e) { if (e && e.key && e.path) libTools[e.key] = e.path; });
    var ops = [
      { op: 'set', path: ['entries'], value: v.entries || [] },
      { op: 'set', path: ['roots'], value: v.roots || [] },
      { op: 'set', path: ['categories'], value: v.categories || [] },
      { op: 'set', path: ['tools'], value: libTools },
      { op: 'set', path: ['services'], value: v.services },
      { op: 'set', path: ['dnslog'], value: v.dnslog },
    ];
    if (v.hiddenTools && v.hiddenTools.length > 0) ops.push({ op: 'set', path: ['hiddenTools'], value: v.hiddenTools });
    else ops.push({ op: 'set', path: ['hiddenTools'], value: [] });
    rpc(props.connection, 'settings/mutate', { ops: ops }).then(function (res) {
      setBusy(false);
      if (res && res.ok) { setMsg('已保存'); props.onSaved && props.onSaved(); refreshStatus(); }
      else setMsg('保存失败：' + ((res && res.error && res.error.message) || '未知错误'));
    });
  }

  return React.createElement('div', null,
    React.createElement(ToolLibrary, { connection: props.connection, value: v, onChange: function (patch) {
      var next = JSON.parse(JSON.stringify(v));
      Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
      props.onChange(next);
    } }),
    React.createElement(Group, { title: '服务连接地址（保存后自动同步到 MCP 工作台，模型立即可见）' },
      React.createElement(ServiceRow, { connection: props.connection, name: 'burp', label: 'Burp Suite 地址', placeholder: 'http://127.0.0.1:9876', value: services.burpUrl || '', status: mountStatus.burp, mounting: mountingName === 'burp', onChange: function (val) { setPath(['services', 'burpUrl'], val); }, onMount: mountOne.bind(null, 'burp') }),
      React.createElement(ServiceRow, { connection: props.connection, name: 'yakit', label: 'Yakit 地址', placeholder: 'http://127.0.0.1:11432', value: services.yakitUrl || '', status: mountStatus.yakit, mounting: mountingName === 'yakit', onChange: function (val) { setPath(['services', 'yakitUrl'], val); }, onMount: mountOne.bind(null, 'yakit') })),
    React.createElement(Group, { title: 'DNSLog 平台' },
      React.createElement('label', { style: labelStyle() }, '平台地址'),
      React.createElement(Input, { value: dnslog.url || '', placeholder: 'http://ceye.io', onChange: function (val) { setPath(['dnslog', 'url'], val); } }),
      React.createElement('label', { style: labelStyle() }, 'Token（保存后仅显示 ***）'),
      React.createElement(Input, { type: 'password', value: dnslog.token || '', placeholder: dnslog.token === '***' ? '已设置，留空保持不变' : 'dnslog token', onChange: function (val) { setPath(['dnslog', 'token'], val); } })),
    React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', margin: '0 0 14px', padding: '8px 10px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2,#f6f6f7)' } },
      'DeepSeek API 密钥请到「平台设置 → 模型/服务」中维护，本页不再重复设置。'),
    React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      React.createElement('button', { type: 'button', disabled: busy, style: btnStyle(true), onClick: save }, busy ? '保存中…' : '保存配置'),
      msg ? React.createElement('span', { style: msgStyle(msg === '已保存') }, msg) : null));
}

function PasswordForm(props) {
  var [masterKey, setMasterKey] = useState('');
  var [newPassword, setNewPassword] = useState('');
  var [confirm, setConfirm] = useState('');
  var [busy, setBusy] = useState(false);
  var [msg, setMsg] = useState('');
  var [ok, setOk] = useState(false);

  function submit() {
    setBusy(true); setMsg(''); setOk(false);
    fetch('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ masterKey: masterKey, newPassword: newPassword, confirm: confirm }).toString(),
    }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (data) {
      setBusy(false);
      if (data && data.ok) {
        setOk(true);
        setMsg('密码已修改，所有会话已失效，请重新登录。');
        setTimeout(function () { window.location.href = '/login.html'; }, 2500);
      } else {
        setMsg('修改失败：' + ((data && data.error) || '未知错误'));
      }
    }).catch(function (e) { setBusy(false); setMsg('请求失败：' + String(e && e.message || e)); });
  }

  return React.createElement('div', null,
    React.createElement('div', { style: groupTitleStyle() }, '修改登录密码'),
    React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', marginBottom: 8 } }, '需要管理密钥（首次启动时打印在终端日志，仅显示一次）；修改后所有已登录会话立即失效。'),
    React.createElement('label', { style: labelStyle() }, '管理密钥'),
    React.createElement(Input, { type: 'password', value: masterKey, onChange: setMasterKey }),
    React.createElement('label', { style: labelStyle() }, '新密码（至少 8 位）'),
    React.createElement(Input, { type: 'password', value: newPassword, onChange: setNewPassword }),
    React.createElement('label', { style: labelStyle() }, '确认新密码'),
    React.createElement(Input, { type: 'password', value: confirm, onChange: setConfirm }),
    React.createElement('div', { style: { marginTop: 12 } },
      React.createElement('button', { type: 'button', disabled: busy, style: btnStyle(true), onClick: submit }, busy ? '提交中…' : '修改密码'),
      msg ? React.createElement('div', { style: msgStyle(ok) }, msg) : null));
}

// One row of a service-endpoint field plus its MCP 工作台 badge + apply button.
// status reflects mcp-studio state + tools count; toolCount === number of
// mcp__<name>__* the model sees in its next prompt assembly.
function ServiceRow(props) {
  var status = props.status || null;
  var badgeStyle = function (bg, fg) {
    return { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: bg, color: fg, lineHeight: '16px', whiteSpace: 'nowrap' };
  };
  var badge = null;
  if (!props.value || props.value.trim() === '') {
    badge = React.createElement('span', { style: badgeStyle('#e4e4e7', '#6e6e73') }, '未配置');
  } else if (!status) {
    badge = React.createElement('span', { style: badgeStyle('#e4e4e7', '#6e6e73') }, '加载中…');
  } else if (status.state === 'connected') {
    badge = React.createElement('span', { style: badgeStyle('#dafbe1', '#1a7f37'), title: status.error || '' }, '● 已挂载 · ' + (status.toolCount || 0) + ' 工具');
  } else if (status.state === 'mounting') {
    badge = React.createElement('span', { style: badgeStyle('#fff8c5', '#9a6700') }, '● 连接中…');
  } else if (status.state === 'disabled') {
    badge = React.createElement('span', { style: badgeStyle('#fff8c5', '#9a6700'), title: 'Burp 缺代理桥（脚本或 jar 都没找到）— 见 sec-config 文件路径常量' }, '● 待启用');
  } else if (status.state === 'error') {
    badge = React.createElement('span', { style: badgeStyle('#ffebe9', '#d1242f'), title: status.error || 'unknown' }, '● 挂载失败');
  } else {
    badge = React.createElement('span', { style: badgeStyle('#ffebe9', '#d1242f') }, '● 不可达');
  }
  return React.createElement('div', { style: { marginBottom: 10 } },
    React.createElement('label', { style: labelStyle() },
      React.createElement('span', null, props.label),
      React.createElement('span', { style: { marginLeft: 8 } }, badge)),
    React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      React.createElement('div', { style: { flex: 1 } }, React.createElement(Input, { value: props.value, placeholder: props.placeholder, onChange: props.onChange })),
      React.createElement('button', { type: 'button', disabled: props.mounting || !props.value, style: btnStyle(false), onClick: props.onMount }, props.mounting ? '同步中…' : '立即挂载')));
}

function Page(props) {
  var [state, setState] = useState({ status: 'loading', value: null });

  function load() {
    rpc(props.connection, 'settings/get', {}).then(function (res) {
      if (res && res.ok && res.value) setState({ status: 'ready', value: res.value.value });
      else setState({ status: 'error', value: null });
    });
  }
  useEffect(load, []);

  if (state.status === 'loading') return React.createElement('div', { style: { fontSize: 13 } }, '加载中…');
  if (state.status === 'error') return React.createElement('div', { style: { fontSize: 13, color: '#d1242f' } }, '无法读取配置，请检查服务是否运行。');

  return React.createElement('div', { style: { maxWidth: 620 } },
    React.createElement(ConfigForm, { connection: props.connection, value: state.value, onChange: function (v) { setState({ status: 'ready', value: v }); }, onSaved: load }),
    React.createElement('hr', { style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', margin: '20px 0' } }),
    React.createElement(PasswordForm, { connection: props.connection }));
}

function apply(ctx) {
  ctx.slots.inject('settings.section', function () {
    return ctx.slots.register({
      name: 'settings.section',
      id: 'sec-config',
      order: 130,
      label: function () { return '安全配置'; },
    }, function () {
      return React.createElement(Page, { connection: ctx.connection });
    });
  });
}

module.exports = { name: 'dsh-sec-config-client', inject: ['slots', 'connection'], apply: apply };
return module.exports; } });
