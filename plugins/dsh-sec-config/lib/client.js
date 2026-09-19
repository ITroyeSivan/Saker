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

/**
 * RPC 失败时 `res.error` 是 `{code, message, details}` **对象**，不是字符串。
 * 直接拿它当 React 子节点渲染会抛 React #31（Objects are not valid as a React child），
 * 而宿主 SlotErrorBoundary 会把整个「安全配置」区吞成空白占位 —— 一个原本只该显示
 * 一行红字的小错误，代价是整块面板消失。所有错误文案必须过这里。
 */
function errText(res, fallback) {
  var e = res && res.error;
  if (!e) return fallback;
  if (typeof e === 'string') return e;
  var head = e.message || e.code || fallback;
  if (e.details === undefined || e.details === null) return head;
  var raw = typeof e.details === 'string' ? e.details : JSON.stringify(e.details);
  // 空对象/空数组是宿主信封的占位，不是有效信息 —— 显示出来只会变成「（{}）」这种噪音
  if (!raw || raw === '{}' || raw === '[]') return head;
  return head + '（' + raw.slice(0, 200) + '）';
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
  return React.createElement('input', {
    type: props.type || 'text', value: props.value, placeholder: props.placeholder, style: fieldStyle(),
    onChange: function (e) { props.onChange(e.target.value); },
    onBlur: props.onBlur ? function () { props.onBlur(); } : undefined,
  });
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
// 分类默认沿用操作者工具库的编号目录风格（01-WebShell管理 … 11-报告与模板）；
// 探测时若根目录下就是这些目录，直接用目录名当分类 id。
var BASE_CATEGORIES = ['01-WebShell管理', '02-流量抓包与代理', '03-扫描与信息收集', '04-漏洞利用', '05-内网与域渗透', '06-C2与免杀', '07-隧道与代理', '08-钓鱼社工', '09-口令与字典', '10-靶场与情报', '11-报告与模板', '信息收集', '漏洞扫描', '目录与接口', '注入与利用', '令牌与认证', '内网与横向', '其他'];
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
  var extras = Array.isArray(cfg && cfg.categories) ? cfg.categories : [];
  var all = BASE_CATEGORIES.slice();
  // 已导入条目用到的分类（例如用户自己的「01-WebShell管理」）必须出现，
  // 否则会被 grouped 归到「其他」而看不见。
  var entries = Array.isArray(cfg && cfg.entries) ? cfg.entries : [];
  entries.forEach(function (e) { if (e && e.category && all.indexOf(e.category) < 0) all.push(e.category); });
  extras.forEach(function (c) { if (c && all.indexOf(c) < 0) all.push(c); });
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
    try {
      var r = S.rootInput.trim();
      if (!r) { up({ msg: '请先输入工具根目录路径' }); return; }
      if (roots.indexOf(r) >= 0) { up({ rootInput: '', msg: '该目录已在列表中' }); return; }
      patchCfg({ roots: roots.concat([r]) });
      up({ rootInput: '', msg: '目录已添加，点「探测并自动导入」开始', msgOk: true });
    } catch (err) { up({ msg: '添加目录出错：' + String(err && err.message || err) }); }
  };
  var removeRoot = function (r) { patchCfg({ roots: roots.filter(function (x) { return x !== r; }) }); };

  var doScan = function () {
    try {
    if (roots.length === 0) { up({ msg: '请先在上方添加工具根目录（可多个）' }); return; }
    up({ scanning: true, msg: null });
    rpc(props.connection, 'catalog/scan', { roots: roots }).then(function (res) {
      if (!res || !res.ok || !res.value || !Array.isArray(res.value.files)) {
        up({ scanning: false, msg: '探测失败：' + ((res && res.error && res.error.message) || '未知错误') });
        return;
      }
      var files = res.value.files;
      // 默认勾选：只勾「内置预设识别」的项（★），其余留空由用户按需勾选——
      // 避免「全选导入」把工具库里的辅助脚本/附带二进制一起灌进配置。
      var picks = {};
      files.forEach(function (f) { if (f.presetKey) picks[f.path] = true; });
      up({ scanning: false, preview: { files: files, picks: picks, catOverride: {} } });
    }).catch(function () { up({ scanning: false, msg: '探测请求失败' }); });
    } catch (err) { up({ scanning: false, msg: '探测出错：' + String(err && err.message || err) }); }
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
  // 扫描结果里的展示名/键名统一取「工具名」（f.tool，已去扩展名），回退文件名。
  var toolStemOf = function (f) { return (f && f.tool) ? f.tool : String((f && f.name) || '').replace(/\.(exe|py|py3|ps1|jar|bat|cmd|sh|pl)$/i, ''); };
  var displayNameOf = function (f) {
    if (f.presetKey) return presetLabelOf(f.presetKey) || f.presetKey;
    return prettyName(sanitizeKey(toolStemOf(f)) || 'tool');
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
      var key = f.presetKey && !existingKeys[f.presetKey] ? f.presetKey : uniqueKey(toolStemOf(f), used);
      existingKeys[key] = true;
      added.push({ key: key, name: displayNameOf(f), path: f.path, category: pv.catOverride[f.path] || f.category || CAT_FALLBACK });
    });
    if (added.length === 0) {
      up({ msg: dup > 0 ? '所选均已在库（跳过重复 ' + dup + ' 项）' : '没有勾选可导入的条目', msgOk: dup > 0 });
      return;
    }
    patchCfg({ entries: entries.concat(added) });
    up({ msgOk: true, preview: null, msg: '已导入 ' + added.length + ' 项' + (dup ? '（跳过重复 ' + dup + '）' : '') + '，点「保存配置」生效' });
  };
  var importOne = function (f) {
    if (entries.some(function (e) { return e.path === f.path; })) { up({ msg: '该工具已在库中' }); return; }
    var used = entries.map(function (e) { return e.key; });
    var key = f.presetKey && used.indexOf(f.presetKey) < 0 ? f.presetKey : uniqueKey(toolStemOf(f), used);
    var name = displayNameOf(f);
    patchCfg({ entries: entries.concat([{ key: key, name: name, path: f.path, category: f.category || CAT_FALLBACK }]) });
    var pv = S.preview;
    if (pv) up({ preview: Object.assign({}, pv, { files: pv.files.filter(function (x) { return x.path !== f.path; }) }), msg: '已导入 ' + name, msgOk: true });
  };

  var removeEntry = function (key) { patchCfg({ entries: entries.filter(function (e) { return e.key !== key; }) }); };
  var setEntryCat = function (key, cat) { patchCfg({ entries: entries.map(function (e) { return e.key === key ? Object.assign({}, e, { category: cat }) : e; }) }); };

  var manualAdd = function () {
    var name = S.manual.name.trim(); var p = S.manual.path.trim();
    if (!TOOL_NAME_RE.test(name)) { up({ msg: '工具名只允许字母/数字/下划线' }); return; }
    if (!p) { up({ msg: '请填写工具绝对路径' }); return; }
    if (entries.some(function (e) { return e.path === p || e.key === name; })) { up({ msg: '该路径或名称已在库中' }); return; }
    patchCfg({ entries: entries.concat([{ key: name, name: name, path: p, category: S.manual.cat || CAT_FALLBACK }]) });
    up({ manual: { cat: S.manual.cat || CAT_FALLBACK, name: '', path: '' }, msg: '已加入，点「保存配置」生效', msgOk: true });
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
  // 1) 目录格式提示（默认折叠，避免长说明压住真实操作区）
  children.push(el('details', { key: 'hint', style: { marginBottom: 10, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2,#f6f6f7)', border: '1px dashed var(--dsw-alias-border-l1,#d9d9de)' } },
    el('summary', { style: { cursor: 'pointer', padding: '8px 12px', fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary,#1a1a1a)' } }, '工具目录格式与探测说明'),
    el('div', { style: { padding: '0 12px 10px', fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-tertiary,#6e6e73)' } },
      el('div', null, '默认工具库为空；添加「工具根目录」（可多个）后一键探测，按目录自动分类导入。推荐结构（一个目录 = 一个工具）：'),
      el('code', { style: { background: 'rgba(127,127,127,.12)', padding: '1px 5px', borderRadius: 4 } }, '工具根/05-内网与域渗透/Kerbrute/kerbrute_windows_amd64.exe'),
      el('div', null, '分类取根目录下一级的分类目录名（如 01-WebShell管理、05-内网与域渗透），没有编号目录时按名称线索归类。探测按「工具」而非「文件」收录：exe/jar 各自成项，脚本需与所在目录同名（如 sqlmap/sqlmap.py），仓库内部模块与测试文件自动排除。分散在别处的工具用「按分类手动导入」。'),
      el('div', { style: { marginTop: 6, paddingTop: 6, borderTop: '1px dashed var(--dsw-alias-border-l1,#d9d9de)' } },
        el('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary,#1a1a1a)' } }, '探测不到某个工具？先看这里：'),
        el('div', null, '① 只有安装包的情况很常见（典型如 Nmap：官网只发 nmap-7.99-setup.exe）。安装包不被当作工具收录——探测器会跳过 '),
        el('code', { style: { background: 'rgba(127,127,127,.12)', padding: '1px 5px', borderRadius: 4 } }, '*-setup.exe / *.msi / *.zip / *.7z / *.tar*'),
        el('div', null, '② 想免安装使用：把解压/安装后的真实可执行文件放到工具根目录下的任意分类目录里（如 03-扫描与信息收集/Nmap/nmap.exe），再点「探测并自动导入」即可识别。'),
        el('div', null, '③ 已装但不在 PATH、也不想放进工具根目录：用下面的「按分类手动导入」直接填绝对路径，或把该目录加进系统 PATH。')))));
  // 2) 根目录编辑 + 探测
  var rootRow = [];
  rootRow.push(el(Input, { key: 'ri', value: S.rootInput, placeholder: '工具根目录，如 D:\\Tools（可添加多个）', onChange: setRootInput }));
  rootRow.push(el('button', { key: 'add', type: 'button', style: rowBtnStyle(), onClick: addRoot }, '添加目录'));
  rootRow.push(el('button', { key: 'scan', type: 'button', disabled: S.scanning, style: rowBtnStyle({ borderColor: '#2f81f7', color: '#2f81f7' }), onClick: doScan }, S.scanning ? '探测中…' : '探测并自动导入'));
  children.push(el('div', { key: 'roots', style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 6 } }, rootRow));
  if (roots.length > 0) {
    children.push(el('div', { key: 'rootlist', style: { display: 'flex', flexWrap: 'wrap', gap: 6, margin: '2px 0 8px' } }, roots.map(function (r) {
      return el('span', { key: r, style: { display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: '100%', padding: '3px 8px', borderRadius: 999, fontSize: 12, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: 'var(--dsw-alias-bg-layer-2,#f6f6f7)' } },
        el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r),
        el('button', { type: 'button', title: '移出该目录', style: { border: 'none', background: 'transparent', color: '#d1242f', cursor: 'pointer', fontSize: 12, padding: 0, flex: '0 0 auto' }, onClick: function () { removeRoot(r); } }, '×'));
    })));
  }
  // 3) 探测预览
  if (S.preview && S.preview.files) {
    var pv = S.preview;
    var prevKids = [];
    var pickedCount = Object.keys(pv.picks).length;
    prevKids.push(el('div', { key: 'meta', style: Object.assign({}, miniHint, { marginBottom: 4 }) }, '探测到 ' + pv.files.length + ' 个工具（★=内置预设已识别，已默认勾选 ' + pickedCount + ' 项）：'));
    prevKids.push(el('button', { key: 'all', type: 'button', style: rowBtnStyle(), onClick: function () { var picks = {}; pv.files.forEach(function (f) { if (f.presetKey) picks[f.path] = true; }); up({ preview: Object.assign({}, pv, { picks: picks }) }); } }, '全选识别项'));
    prevKids.push(el('button', { key: 'none', type: 'button', style: rowBtnStyle(), onClick: function () { up({ preview: Object.assign({}, pv, { picks: {} }) }); } }, '清空'));
    pv.files.forEach(function (f) {
      prevKids.push(el('div', { key: f.path, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', fontSize: 12 } },
        el('input', { type: 'checkbox', checked: !!pv.picks[f.path], onChange: function () { togglePick(f.path); } }),
        el('select', { value: pv.catOverride[f.path] || f.category || CAT_FALLBACK, style: { fontSize: 11, maxWidth: 130 }, onChange: function (e) { setFileCat(f.path, e.target.value); } }, cats.map(function (c) { return el('option', { key: c, value: c }, c); })),
        el('span', { style: { flex: '0 0 130px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (f.presetKey ? '★ ' + (presetLabelOf(f.presetKey) || f.presetKey) : (f.tool || f.name))),
        el('span', { title: f.path, style: { flex: 1, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.path),
        el('button', { type: 'button', style: rowBtnStyle(), onClick: function () { importOne(f); } }, '单导')));
    });
    prevKids.push(el('div', { key: 'go', style: { marginTop: 6 } },
      el('button', { type: 'button', style: rowBtnStyle({ background: '#2f81f7', color: '#fff', borderColor: '#2f81f7' }), onClick: importSelection }, '导入勾选项')));
    children.push(el('div', { key: 'preview', style: { border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', borderRadius: 8, margin: '4px 0 8px', padding: 8, maxHeight: 300, overflow: 'auto' } }, prevKids));
  }
  // 4) 分类树（只渲染「有工具」的分类；空分类在下方「分类管理」里可见可删）
  var usedCats = cats.filter(function (c) { return (grouped[c] || []).length > 0; });
  if (usedCats.length === 0) {
    children.push(el('div', { key: 'emptyall', style: miniHint }, '工具库为空：添加根目录后点「探测并自动导入」，或用下方「按分类手动导入」。'));
  }
  usedCats.forEach(function (c) {
    var rows = grouped[c] || [];
    var kids = rows.map(function (e) {
          return el('div', { key: e.key, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 13 } },
            el('span', { style: { flex: '0 0 150px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, e.name || e.key),
            el('span', { title: e.path, style: { flex: 1, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 } }, e.path),
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
  if (S.msg) children.push(el('div', { key: 'msg', style: msgStyle(S.msgOk === true) }, S.msg));
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
    }).catch(function (e) {
      // 没有 catch 时 RPC 一旦 reject（宿主重启 / 连接层协议错）busy 永远为 true，
      // 保存按钮就一直是"保存中…"且没有任何提示。补上兜底。
      setBusy(false); setMsg('保存失败：' + String((e && e.message) || e));
    });
  }

  return React.createElement('div', null,
    React.createElement('div', { style: { marginBottom: 12 } },
      React.createElement('div', { style: { fontSize: 16, fontWeight: 700, color: 'var(--dsw-alias-label-primary,#1a1a1a)' } }, '安全配置'),
      React.createElement('div', { style: hintStyle() }, '管理工具库、Burp / Yakit 服务地址、DNSLog 与平台安全策略。')),
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

// ── 模型接入（第三方网关走本机代理）────────────────────────────────────────
// dsh 不自带 x-opencode-session 头，直连 opencode.ai 会 400 MissingSessionID；
// 指向本机代理后由代理补齐该头、并按需剥掉客户端私有字段。
// 目标地址**只写到 /v1** —— dsh 会自己在后面拼 /chat/completions，
// 多写一层会变成 /v1/chat/completions/chat/completions，上游回 404（实测踩过）。
var MODEL_MODES = [
  { id: 'proxy', label: '走本机代理（内置，推荐）' },
  { id: 'direct', label: '直连上游（dsh 会 400，仅供排查）' },
  { id: 'custom', label: '自定义地址' },
];
var REDACTION_MODES = [
  { id: 'secrets', label: '密钥脱敏（推荐）' },
  { id: 'secrets+pii', label: '密钥 + PII' },
  { id: 'off', label: '关闭脱敏' },
];

function ModelLink(props) {
  var [st, setSt] = useState({ status: 'loading', value: null });
  var [draft, setDraft] = useState({});
  var [busy, setBusy] = useState('');
  var [msg, setMsg] = useState(null);
  var [probe, setProbe] = useState(null);

  function load() {
    rpc(props.connection, 'model/state', {}).then(function (res) {
      if (res && res.ok && res.value) { setSt({ status: 'ready', value: res.value }); setDraft({}); }
      else setSt({ status: 'error', value: null });
    });
  }
  useEffect(load, []);

  // 只写单个字段（settings/mutate 的 path-ops），不重述其他配置
  function writeField(key, value) {
    setBusy('save');
    rpc(props.connection, 'settings/mutate', { ops: [{ op: 'set', path: ['model', key], value: value }] })
      .then(function () { return rpc(props.connection, 'model/state', {}); })
      .then(function (res) {
        setBusy('');
        if (res && res.ok && res.value) { setSt({ status: 'ready', value: res.value }); setDraft({}); }
      });
  }

  function doApply() {
    setBusy('apply'); setMsg(null);
    rpc(props.connection, 'model/apply', {}).then(function (res) {
      setBusy('');
      if (res && res.ok && res.value) {
        setMsg({ ok: true, text: '已写入 ' + res.value.baseURL + ' —— 重启 dsh 后生效' });
        load();
      } else setMsg({ ok: false, text: errText(res, '写入失败') });
    });
  }

  function doProbe() {
    setBusy('probe'); setProbe(null); setMsg(null);
    rpc(props.connection, 'model/probe', {}).then(function (res) {
      setBusy('');
      if (res && res.ok && res.value) {
        var r = res.value;
        setProbe(r);
        setMsg({ ok: r.ok, text: (r.ok ? '连通正常' : '连不通') + ' · HTTP ' + r.status + ' · ' + r.ms + 'ms' + (r.error ? ' · ' + r.error : '') });
      } else setMsg({ ok: false, text: errText(res, '探测失败') });
    });
  }

  function doProxy(action) {
    setBusy('proxy'); setMsg(null);
    rpc(props.connection, 'model/proxy', { action: action }).then(function (res) {
      setBusy('');
      if (res && res.ok && res.value) {
        var p = res.value.proxy;
        var bp = res.value.builtinProxy || {};
        var up = p && p.ok;
        var text = action === 'stop' ? '已停止内置代理' : (up ? '内置代理已在运行' : '内置代理未响应');
        if (action !== 'stop' && bp.error) text += '：' + bp.error;
        setMsg({ ok: !!up, text: text + (up && p.health ? '（build ' + (p.health.build || p.health.kind) + '）' : '') });
        load();
      } else setMsg({ ok: false, text: errText(res, '操作失败') });
    });
  }

  if (st.status === 'loading') return React.createElement('div', { style: { fontSize: 13 } }, '加载中…');
  if (st.status === 'error') return null;
  var v = st.value;

  var draftOf = function (key, fallback) {
    return draft[key] !== undefined ? draft[key] : String(fallback === undefined || fallback === null ? '' : fallback);
  };

  var badge = v.installedBaseUrl === null
    ? React.createElement('span', { style: { color: '#d1242f' } }, 'provider 未注册')
    : (v.inSync
      ? React.createElement('span', { style: { color: '#1a7f37' } }, '● 已生效')
      : React.createElement('span', { style: { color: '#9a6700' } }, '● 待写入'));

  function modeBtn(m) {
    var active = v.mode === m.id;
    return React.createElement('button', {
      key: m.id, type: 'button', disabled: busy !== '',
      onClick: function () { writeField('mode', m.id); },
      style: { padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
        border: '1px solid ' + (active ? '#2f81f7' : 'var(--dsw-alias-border-l1,#d9d9de)'),
        background: active ? '#e8f1fe' : 'transparent',
        color: active ? '#1d4ed8' : 'var(--dsw-alias-label-primary,#1a1a1a)' },
    }, m.label);
  }
  function redactionBtn(r) {
    var active = (v.redaction || 'secrets') === r.id;
    return React.createElement('button', {
      key: r.id, type: 'button', disabled: busy !== '',
      onClick: function () { writeField('redaction', r.id); },
      style: { padding: '5px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
        border: '1px solid ' + (active ? '#2f81f7' : 'var(--dsw-alias-border-l1,#d9d9de)'),
        background: active ? '#e8f1fe' : 'transparent', color: active ? '#1d4ed8' : 'var(--dsw-alias-label-primary,#1a1a1a)' },
    }, r.label);
  }

  return React.createElement(Group, { title: '模型接入（OpenCode Go）' },
    React.createElement('div', { style: hintStyle() },
      'OpenCode Go 这类网关要求请求带 x-opencode-session 头，dsh 没有注入自定义头的入口，直连会被判 400 MissingSessionID。开启本机代理即可：代理由本插件自带并在宿主内运行，不需要另装或手动启动任何程序。目标地址只写到 /v1，剩下的路径由 dsh 自己拼。'),
    React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 } }, MODEL_MODES.map(modeBtn)),
    v.mode === 'proxy' ? React.createElement('div', { style: { marginBottom: 8 } },
      React.createElement('label', { style: labelStyle() }, '出站脱敏（只作用于本机模型代理）'),
      React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, REDACTION_MODES.map(redactionBtn)),
      React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #6e6e73)', marginTop: 4 } },
        '默认按字段名与内容识别 Authorization/Cookie、密码、私钥、云密钥和常见 token；保留目标 IP、域名、URL 与普通验证载荷。「密钥 + PII」再脱敏邮箱、手机号、身份证和 Luhn 校验通过的银行卡号，按需开启。')) : null,
    v.mode === 'proxy' ? React.createElement('div', null,
      React.createElement('label', { style: labelStyle() }, '代理监听端口（本机回环，内置代理用这个端口）'),
      React.createElement(Input, {
        value: draftOf('listenPort', v.listenPort), placeholder: '8788',
        onChange: function (t) { setDraft(Object.assign({}, draft, { listenPort: t })); },
        onBlur: function () { var n = parseInt(draftOf('listenPort', v.listenPort), 10); writeField('listenPort', isNaN(n) ? 8788 : n); },
      })) : null,
    v.mode === 'custom' ? React.createElement('div', null,
      React.createElement('label', { style: labelStyle() }, '自定义目标地址（写到 /v1 为止）'),
      React.createElement(Input, {
        value: draftOf('customBaseUrl', v.customBaseUrl), placeholder: 'http://127.0.0.1:8788/v1',
        onChange: function (t) { setDraft(Object.assign({}, draft, { customBaseUrl: t })); },
        onBlur: function () { writeField('customBaseUrl', draftOf('customBaseUrl', v.customBaseUrl)); },
      })) : null,
    React.createElement('div', { style: { marginTop: 10, fontSize: 12, lineHeight: 1.9, color: 'var(--dsw-alias-label-tertiary, #6e6e73)' } },
      React.createElement('div', null, '目标地址：', React.createElement('code', null, v.targetBaseUrl || '（空）')),
      React.createElement('div', null, '当前生效：',
        React.createElement('code', null, v.installedBaseUrl === null ? '（未读到）' : (v.installedBaseUrl || '（空）')), ' ', badge),
      (v.mode === 'proxy' && v.proxy)
        ? React.createElement('div', null, '代理状态：',
            React.createElement('span', { style: { color: v.proxy.ok ? '#1a7f37' : '#d1242f' } },
              v.proxy.ok ? '● 在线' : ((v.builtinProxy && v.builtinProxy.error) ? '● 启动失败' : '● 未运行')),
            (v.proxy.ok && v.proxy.health)
              ? '（' + (v.proxy.health.kind === 'builtin' ? '内置代理' : '已有服务在监听该端口')
                + (v.proxy.health.stats ? ' · 已转发 ' + v.proxy.health.stats.requests + ' 次 · 剥字段 ' + v.proxy.health.stats.stripped : '')
                + (v.proxy.health.stats ? ' · 脱敏 ' + (v.proxy.health.stats.redacted || 0) : '')
                + (v.proxy.health.stats && v.proxy.health.stats.redactedKinds
                  ? '（' + Object.entries(v.proxy.health.stats.redactedKinds).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 3).map(function (pair) { return pair[0] + ':' + pair[1]; }).join(' / ') + '）'
                  : '')
                + '）'
              : '')
        : null),
    (v.mode === 'proxy' && v.proxy && v.proxy.ok && v.proxy.health && v.proxy.health.stats
      && Array.isArray(v.proxy.health.stats.events) && v.proxy.health.stats.events.length > 0)
      ? React.createElement('div', null, '最近出站：',
          React.createElement('code', null,
            (v.proxy.health.stats.events[v.proxy.health.stats.events.length - 1].method || 'GET') + ' '
            + (v.proxy.health.stats.events[v.proxy.health.stats.events.length - 1].path || '/')
            + ' → ' + (v.proxy.health.stats.events[v.proxy.health.stats.events.length - 1].status || '?')))
      : null,
    (v.builtinProxy && v.builtinProxy.error)
      ? React.createElement('div', { style: { color: '#d1242f', fontSize: 12, marginTop: 4 } }, v.builtinProxy.error)
      : null,
    React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
      React.createElement('button', { type: 'button', style: btnStyle(false), disabled: busy !== '', onClick: load }, '刷新状态'),
      React.createElement('button', { type: 'button', style: btnStyle(false), disabled: busy !== '', onClick: doProbe }, busy === 'probe' ? '测试中…' : '测试连通'),
      (v.mode === 'proxy' && !(v.proxy && v.proxy.ok))
        ? React.createElement('button', { type: 'button', style: btnStyle(false), disabled: busy !== '', onClick: function () { doProxy('start'); } }, busy === 'proxy' ? '启动中…' : '启动内置代理')
        : null,
      (v.mode === 'proxy' && v.proxy && v.proxy.ok && v.proxy.health && v.proxy.health.kind === 'builtin')
        ? React.createElement('button', { type: 'button', style: btnStyle(false), disabled: busy !== '', onClick: function () { doProxy('stop'); } }, '停止内置代理')
        : null,
      React.createElement('button', { type: 'button', style: btnStyle(true), disabled: busy !== '' || v.inSync, onClick: doApply }, busy === 'apply' ? '写入中…' : (v.inSync ? '已是最新' : '写入配置'))),
    msg ? React.createElement('div', { style: msgStyle(msg.ok) }, msg.text) : null,
    (probe && probe.body)
      ? React.createElement('div', { style: { marginTop: 6, fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', wordBreak: 'break-all' } }, probe.body.slice(0, 160))
      : null);
}

var EP_KINDS = [
  { id: 'proxy', label: '本机代理' },
  { id: 'upstream', label: '直连上游' },
  { id: 'baseline', label: '初始地址' },
  { id: 'default', label: '清除覆盖（仅内建 provider）' },
  { id: 'custom', label: '自定义' },
];

/**
 * 端点档案：把「换供应商」变成一次点击。
 *
 * 动机：上游（OpenCode Go 等）随时可能改鉴权方式，或某天 dsh 原生就能接——
 * 那时不该去「设置 → 模型」手改 baseURL，而应该点一下就切过去、且能一键切回来。
 *
 * 「切回来」靠的是**初始地址快照**，不是「清除覆盖」：
 * 实测宿主会以 `provider "custom" model "glm-5.3-flash" needs a baseURL;
 * the installed catalog does not describe this route` 拒绝清空自定义 provider 的地址——
 * 自定义模型 id 不在 dsh 内建目录里，baseURL 就是必填，没有「默认端点」可回退。
 */
function EndpointProfiles(props) {
  var [st, setSt] = useState({ status: 'loading', value: null });
  var [busy, setBusy] = useState('');
  var [msg, setMsg] = useState(null);
  var [form, setForm] = useState({ name: '', baseURL: '', kind: 'custom' });

  function load() {
    rpc(props.connection, 'model/endpoints', {}).then(function (res) {
      if (res && res.ok && res.value) setSt({ status: 'ready', value: res.value });
      else setSt({ status: 'error', value: null });
    });
  }
  useEffect(load, []);

  function use(id) {
    setBusy('use:' + id); setMsg(null);
    rpc(props.connection, 'model/endpoint-use', { id: id }).then(function (res) {
      setBusy('');
      if (res && res.ok && res.value) {
        var v = res.value;
        setMsg({ ok: true, text: '已切到「' + v.used + '」' + (v.op === 'unset' ? '（已清除 baseURL 覆盖，回到 dsh 默认）' : ' → ' + v.baseURL) + ' · 重启 dsh 后生效' });
        load();
        if (props.onChanged) props.onChanged();
      } else setMsg({ ok: false, text: errText(res, '切换失败') });
    });
  }

  function save(p, silent) {
    setBusy('save'); if (!silent) setMsg(null);
    rpc(props.connection, 'model/endpoint-save', { profile: p }).then(function (res) {
      setBusy('');
      if (res && res.ok && res.value) {
        if (!silent) setMsg({ ok: true, text: '档案已保存：' + (res.value.saved && res.value.saved.name) });
        load();
      } else setMsg({ ok: false, text: errText(res, '保存失败') });
    });
  }

  function del(id) {
    setBusy('del:' + id); setMsg(null);
    rpc(props.connection, 'model/endpoint-delete', { id: id }).then(function (res) {
      setBusy('');
      if (res && res.ok) load();
      else setMsg({ ok: false, text: errText(res, '删除失败') });
    });
  }

  function captureBaseline() {
    setBusy('baseline'); setMsg(null);
    rpc(props.connection, 'model/endpoint-baseline', {}).then(function (res) {
      setBusy('');
      if (res && res.ok && res.value) {
        setMsg({ ok: true, text: '已把当前地址记为初始地址：' + res.value.baseline.baseURL });
        load();
      } else setMsg({ ok: false, text: errText(res, '记录失败') });
    });
  }

  if (st.status === 'loading') return React.createElement('div', { style: { fontSize: 13 } }, '端点档案加载中…');
  if (st.status === 'error') return null;
  var v = st.value;
  var rows = (v.profiles && v.profiles.length) ? v.profiles.map(function (p) { return { p: p, saved: true }; })
    : (v.suggestions || []).map(function (p) { return { p: p, saved: false }; });

  function kindLabel(k) {
    var hit = null;
    EP_KINDS.forEach(function (x) { if (x.id === k) hit = x; });
    return hit ? hit.label : k;
  }

  function row(item) {
    var p = item.p;
    var active = v.activeProfileId === p.id;
    return React.createElement('div', {
      key: p.id,
      style: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--dsw-alias-border-l1,#f0f0f2)' },
    },
      React.createElement('div', { style: { flex: 1, minWidth: 0 } },
        React.createElement('div', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary,#1a1a1a)' } },
          p.name,
          ' ',
          React.createElement('span', { style: { fontSize: 11, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary,#6e6e73)' } }, '· ' + kindLabel(p.kind)),
          active ? React.createElement('span', { style: { fontSize: 11, marginLeft: 6, color: '#1a7f37' } }, '● 当前') : null),
        React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', wordBreak: 'break-all' } },
          p.baseURL || '（无 baseURL 覆盖）', p.note ? ' · ' + p.note : '')),
      React.createElement('button', {
        type: 'button', style: btnStyle(!active), disabled: busy !== '' || active,
        onClick: function () { use(p.id); },
      }, active ? '已生效' : (busy === 'use:' + p.id ? '切换中…' : '切到这一档')),
      item.saved
        ? React.createElement('button', {
            type: 'button', style: btnStyle(false), disabled: busy !== '',
            onClick: function () { del(p.id); },
          }, busy === 'del:' + p.id ? '删除中…' : '删除')
        : React.createElement('button', {
            type: 'button', style: btnStyle(false), disabled: busy !== '',
            onClick: function () { save({ name: p.name, baseURL: p.baseURL, kind: p.kind, note: p.note }, false); },
          }, '存为档案'));
  }

  return React.createElement(Group, { title: '模型端点档案（一键切换供应商）' },
    React.createElement('div', { style: hintStyle() },
      '把常用的上游地址存成档案，换供应商时点一下就切过去，不用去「设置 → 模型」手改 baseURL。当前 provider：',
      React.createElement('code', null, v.provider),
      v.namespaceReady ? null : React.createElement('span', { style: { color: '#d1242f' } }, '（该 provider 未注册，先在「设置 → 模型」建好）')),
    React.createElement('div', { style: hintStyle() },
      '「回得去」靠的是「恢复初始地址」档：自定义 provider 的模型不在 dsh 内建目录里，baseURL 是必填项，清掉会被宿主判为非法配置。',
      '想切回原来的地址就用它（', v.baseline && v.baseline.baseURL ? '当前记录：' + v.baseline.baseURL : '尚未记录，点下方按钮记一次', '）。'),
    React.createElement('div', { style: { fontSize: 12, lineHeight: 1.9, marginBottom: 8, color: 'var(--dsw-alias-label-tertiary, #6e6e73)' } },
      React.createElement('div', null, '当前生效：',
        React.createElement('code', null, v.installedBaseUrl === null ? '（未读到）' : (v.installedBaseUrl || '（无覆盖）'))),
      React.createElement('div', null, '命中档位：',
        React.createElement('code', null, v.activeProfileName || '（不匹配任何档案）'),
        v.isDefault ? React.createElement('span', { style: { marginLeft: 6, color: '#1a7f37' } }, '● 无覆盖') : null)),
    rows.length
      ? React.createElement('div', null, rows.map(row))
      : React.createElement('div', { style: hintStyle() }, '（还没有档案）'),
    React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
      React.createElement('button', {
        type: 'button', style: btnStyle(false), disabled: busy !== '' || !v.installedBaseUrl,
        onClick: captureBaseline,
      }, busy === 'baseline' ? '记录中…' : '把当前生效地址记为初始地址')),
    React.createElement('div', { style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l1,#e4e4e7)' } },
      React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 2 } }, '新增/更新档案'),
      React.createElement('label', { style: labelStyle() }, '档案名（同 id 即更新；新档案填个新的名字即可）'),
      React.createElement(Input, {
        value: form.name, placeholder: '例如：OpenCode Go（代理）',
        onChange: function (t) { setForm(Object.assign({}, form, { name: t })); },
      }),
      React.createElement('label', { style: labelStyle() }, '类型'),
      React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        EP_KINDS.map(function (k) {
          var on = form.kind === k.id;
          return React.createElement('button', {
            key: k.id, type: 'button', disabled: busy !== '',
            onClick: function () { setForm(Object.assign({}, form, { kind: k.id })); },
            style: { padding: '5px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
              border: '1px solid ' + (on ? '#2f81f7' : 'var(--dsw-alias-border-l1,#d9d9de)'),
              background: on ? '#e8f1fe' : 'transparent', color: on ? '#1d4ed8' : 'var(--dsw-alias-label-primary,#1a1a1a)' },
          }, k.label);
        })),
      form.kind === 'default'
        ? React.createElement('div', { style: { marginTop: 6, fontSize: 11, color: '#9a6700' } }, '这一档不需要地址：切换时清除 baseURL 覆盖。⚠️ 仅当该 provider 的模型在 dsh 内建目录里才成立；自定义 provider 会被宿主判为缺 baseURL 而拒绝（届时会给出提示，配置不会被改坏）。')
        : React.createElement('div', null,
            React.createElement('label', { style: labelStyle() }, '端点地址（写到 /v1 为止）'),
            React.createElement(Input, {
              value: form.baseURL, placeholder: 'http://127.0.0.1:8788/v1',
              onChange: function (t) { setForm(Object.assign({}, form, { baseURL: t })); },
            })),
      React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
        React.createElement('button', {
          type: 'button', style: btnStyle(true), disabled: busy !== '',
          onClick: function () {
            save({ name: form.name, baseURL: form.baseURL, kind: form.kind }, false);
            setForm({ name: '', baseURL: '', kind: 'custom' });
          },
        }, busy === 'save' ? '保存中…' : '保存档案'),
        React.createElement('button', { type: 'button', style: btnStyle(false), disabled: busy !== '', onClick: load }, '刷新'))),
    msg ? React.createElement('div', { style: msgStyle(msg.ok) }, msg.text) : null);
}

// 统一出站策略：跨插件总闸（infra 出站）。判定逻辑在根包 dsh-saker/egress，
// 这里只负责让用户改档位并看到最近判定。
var EGRESS_MODES = [
  { id: 'allow', label: '不拦（默认）', hint: '基础设施出站全部放行' },
  { id: 'allowlist', label: '只放白名单', hint: '只有下面列出的域名/主机能出网' },
  { id: 'frozen', label: '冻结基础设施出站', hint: '模型上游、知识同步、包下载全部拦下' },
];

function EgressPolicy(props) {
  var [state, setState] = useState({ status: 'loading', policy: null, source: '', audit: [] });
  var [hosts, setHosts] = useState('');
  var [busy, setBusy] = useState('');
  var [msg, setMsg] = useState(null);

  function applyPayload(payload) {
    var p = payload || {};
    setState({ status: 'ready', policy: p.policy || null, source: p.source || '', audit: p.audit || [] });
    setHosts((((p.policy || {}).allowHosts) || []).join('\n'));
  }
  function load() {
    rpc(props.connection, 'egress/get', {}).then(function (res) {
      if (res && res.ok && res.value) applyPayload(res.value);
      else setState({ status: 'error', policy: null, source: '', audit: [] });
    });
  }
  useEffect(load, []);

  function save(mode) {
    setBusy(mode); setMsg(null);
    rpc(props.connection, 'egress/set', { mode: mode, allowHosts: String(hosts || '').split(/\s+/).filter(Boolean) }).then(function (res) {
      setBusy('');
      if (res && res.ok && res.value) { applyPayload(res.value); setMsg({ ok: true, text: '已保存：' + mode }); }
      else setMsg({ ok: false, text: errText(res, '保存失败') });
    });
  }

  if (state.status === 'loading') {
    return React.createElement(Group, { title: '统一出站策略' }, React.createElement('div', { style: hintStyle() }, '加载中…'));
  }
  if (state.status === 'error') {
    return React.createElement(Group, { title: '统一出站策略' },
      React.createElement('div', { style: { fontSize: 12, color: '#d1242f' } }, '读不到策略文件（dsh-saker 根包未装或过旧）。'));
  }
  var policy = state.policy || { mode: 'allow', allowHosts: [] };
  var recent = (state.audit || []).slice(-6).reverse();
  return React.createElement(Group, { title: '统一出站策略（跨插件总闸）' },
    React.createElement('div', { style: hintStyle() },
      '管的是基础设施出站：模型上游、知识包 git 同步、MCP 包下载（npx/uvx）。',
      '目标流量（打目标站点与服务）不归它管——那由授权范围与 scope 约束。'),
    React.createElement('div', { style: hintStyle() },
      '当前档位：', React.createElement('code', null, policy.mode || 'allow'),
      ' · 策略文件来源：', React.createElement('code', null, state.source || 'file'),
      policy.updatedAt ? ' · 更新于 ' + String(policy.updatedAt).replace('T', ' ').slice(0, 19) : ''),
    React.createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
      EGRESS_MODES.map(function (m) {
        var on = (policy.mode || 'allow') === m.id;
        return React.createElement('button', {
          key: m.id, type: 'button', title: m.hint, disabled: busy !== '',
          onClick: function () { save(m.id); },
          style: { padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
            border: '1px solid ' + (on ? '#2f81f7' : 'var(--dsw-alias-border-l1,#d9d9de)'),
            background: on ? '#e8f1fe' : 'transparent', color: on ? '#1d4ed8' : 'var(--dsw-alias-label-primary,#1a1a1a)' },
        }, busy === m.id ? '切换中…' : (on ? '● ' + m.label : m.label));
      })),
    React.createElement('label', { style: labelStyle() }, '白名单（每行一个域名；只放白名单档生效，子域按标签后缀命中）'),
    React.createElement('textarea', {
      value: hosts, rows: 4, spellCheck: false, placeholder: 'github.com\nregistry.npmjs.org',
      onChange: function (e) { setHosts(e.target.value); },
      style: Object.assign({}, fieldStyle(), { width: '100%', resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }),
    }),
    React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
      React.createElement('button', {
        type: 'button', style: btnStyle(false), disabled: busy !== '',
        onClick: function () { save(policy.mode || 'allow'); },
      }, busy === (policy.mode || 'allow') ? '保存中…' : '保存白名单'),
      React.createElement('button', { type: 'button', style: btnStyle(false), disabled: busy !== '', onClick: load }, '刷新')),
    recent.length
      ? React.createElement('div', { style: { marginTop: 10, fontSize: 11, lineHeight: 1.8, color: 'var(--dsw-alias-label-tertiary,#6e6e73)' } },
          React.createElement('div', { style: { fontWeight: 600 } }, '最近出站判定'),
          recent.map(function (row, i) {
            return React.createElement('div', { key: i },
              String(row.at || '').replace('T', ' ').slice(11, 19), ' · ',
              React.createElement('code', null, row.plugin || '?'), ' → ',
              row.host || '(local)', ' · ',
              React.createElement('span', { style: { color: row.decision === 'deny' ? '#d1242f' : '#1a7f37' } }, row.decision),
              '（', row.reason, '）');
          }))
      : React.createElement('div', { style: hintStyle() }, '（还没有出站判定记录）'),
    msg ? React.createElement('div', { style: msgStyle(msg.ok) }, msg.text) : null);
}

function Page(props) {
  var [state, setState] = useState({ status: 'loading', value: null });
  // 切档后要刷新 ModelLink 的「当前生效」——用 key 触发重挂载，避免把两处状态耦合起来。
  var [rev, setRev] = useState(0);

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
    React.createElement(ModelLink, { key: 'model-' + rev, connection: props.connection }),
    React.createElement('hr', { style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', margin: '20px 0' } }),
    React.createElement(EndpointProfiles, { connection: props.connection, onChanged: function () { setRev(function (n) { return n + 1; }); } }),
    React.createElement('hr', { style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', margin: '20px 0' } }),
    React.createElement(EgressPolicy, { connection: props.connection }),
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
