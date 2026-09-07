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
  { key: 'fscan', label: 'Fscan', category: '漏洞扫描' },
  { key: 'dirsearch', label: 'Dirsearch', category: '目录与接口' },
  { key: 'katana', label: 'Katana', category: '目录与接口' },
  { key: 'ffuf', label: 'Ffuf', category: '目录与接口' },
  { key: 'sqlmap', label: 'SQLMap', category: '注入与利用' },
  { key: 'jwt_tool', label: 'JWT Tool', category: '令牌与认证' },
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

function ToolRow(props) {
  var badge = props.kind === 'custom' ? CUSTOM_LABEL : PRESET_LABEL;
  var label = props.label;
  var has = props.has;
  var candidates = props.candidates || [];
  var shown = (candidates || []).filter(function (p) { return p !== props.value; }).slice(0, 4);
  return React.createElement('div', { style: { marginBottom: 6 } },
    React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
      React.createElement('span', {
        style: { display: 'inline-flex', alignItems: 'center', padding: '1px 7px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: badge.bg, color: badge.fg, lineHeight: '16px', whiteSpace: 'nowrap', flex: '0 0 auto' },
      }, badge.label),
      React.createElement('div', { style: { flex: '0 0 140px', fontSize: 13, color: 'var(--dsw-alias-label-primary,#1a1a1a)' } }, label),
      React.createElement('div', { style: { flex: 1, minWidth: 120 } },
        React.createElement(Input, {
          value: props.value || '',
          placeholder: has ? '已配置' : (props.placeholder || '工具路径，留空=未添加'),
          onChange: props.onChange,
        })),
      React.createElement('button', {
        type: 'button',
        title: has ? '从配置中移除该工具（空路径不注入、不进提示词）' : '',
        disabled: !has,
        style: {
          padding: '6px 10px', borderRadius: 6, fontSize: 12, cursor: has ? 'pointer' : 'not-allowed',
          border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: has ? 'transparent' : 'transparent',
          color: has ? '#d1242f' : '#c8c8cc', opacity: has ? 1 : 0.6,
        },
        onClick: props.onRemove,
      }, '移除')),
    !has && shown.length > 0 ? React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, margin: '4px 0 2px 0', paddingLeft: 0 } },
      React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', lineHeight: '20px', marginRight: 4 } }, '自动探测到：'),
      shown.map(function (p) {
        return React.createElement('button', {
          key: p, type: 'button', title: p,
          style: { padding: '2px 8px', borderRadius: 999, fontSize: 11, cursor: 'pointer', border: '1px solid #2f81f7', background: 'transparent', color: '#2f81f7', maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          onClick: function () { props.onChange && props.onChange(p); },
        }, p);
      })) : null);
}

function ToolGroup(props) {
  var [presets, setPresets] = useState(null);
  var [newName, setNewName] = useState('');
  var [newPath, setNewPath] = useState('');
  var [msg, setMsg] = useState(null);
  var [cand, setCand] = useState(null); // { roots, candidates: {key:[paths]} }
  var [scanning, setScanning] = useState(false);

  function scan() {
    setScanning(true);
    rpc(props.connection, 'scan-candidates', {}).then(function (res) {
      setScanning(false);
      if (res && res.ok && res.value && res.value.candidates) setCand(res.value);
    }).catch(function () { setScanning(false); });
  }
  useEffect(function () {
    rpc(props.connection, 'tool-presets', {}).then(function (res) {
      if (res && res.ok && res.value && Array.isArray(res.value.presets)) {
        setPresets({ presets: res.value.presets, categories: res.value.categories || CATEGORY_ORDER });
      }
    }).catch(function () { /* fall back to local copy */ });
    scan();
  }, []);

  var catalog = presets ? presets.presets : FALLBACK_PRESETS;
  var categoryOrder = presets ? presets.categories : CATEGORY_ORDER;
  var byKey = {};
  catalog.forEach(function (t) { byKey[t.key] = t; });
  var tools = props.value || {};
  var candidatesOf = function (key) { return (cand && cand.candidates && cand.candidates[key]) || []; };

  function setTool(key, val) {
    var next = JSON.parse(JSON.stringify(tools));
    next[key] = val;
    props.onChange(next);
  }
  function removeTool(key) {
    var next = JSON.parse(JSON.stringify(tools));
    delete next[key];
    props.onChange(next);
  }
  function addCustom() {
    var name = newName.trim();
    var pathv = newPath.trim();
    if (!TOOL_NAME_RE.test(name)) { setMsg('工具名只允许字母/数字/下划线（用于标识，也用于环境变量式引用）'); return; }
    if (name.length > 40) { setMsg('工具名过长（≤40）'); return; }
    if (byKey[name]) { setMsg('该名称与预设工具重复：' + name); return; }
    if (!pathv) { setMsg('请填工具路径'); return; }
    setTool(name, pathv);
    setNewName(''); setNewPath(''); setMsg(null);
  }

  // Preset rows grouped by category (all shown — fill a path to add/select).
  var presetGroups = categoryOrder.map(function (cat) {
    var rows = catalog.filter(function (t) { return t.category === cat; });
    if (rows.length === 0) return null;
    var children = rows.map(function (t) {
      var val = typeof tools[t.key] === 'string' ? tools[t.key] : '';
      return React.createElement(ToolRow, {
        key: t.key, kind: 'preset', label: t.label, value: val, has: val.length > 0,
        placeholder: '选择添加：填路径即可',
        candidates: candidatesOf(t.key),
        connection: props.connection,
        onChange: function (v) { setTool(t.key, v); },
        onRemove: function () { removeTool(t.key); },
      });
    });
    return React.createElement(Group, { key: cat, title: cat }, children);
  });

  // Operator-defined tools (keys outside the preset catalog) with a value.
  var customKeys = Object.keys(tools).filter(function (k) { return !byKey[k] && TOOL_NAME_RE.test(k) && typeof tools[k] === 'string' && tools[k].length > 0; }).sort();
  var customGroup = null;
  if (customKeys.length > 0 || true) {
    var customRows = customKeys.map(function (k) {
      return React.createElement(ToolRow, {
        key: k, kind: 'custom', label: k, value: tools[k], has: true,
        connection: props.connection,
        onChange: function (v) { setTool(k, v); },
        onRemove: function () { removeTool(k); },
      });
    });
    customGroup = React.createElement('div', { style: { marginBottom: 4 } },
      React.createElement('div', { style: { fontSize: 13, fontWeight: 600, margin: '14px 0 6px' } }, '自定义工具'),
      customRows.length > 0 ? customRows : React.createElement('div', { style: { fontSize: 12, color: '#9a9aa0' } }, '还没有自定义工具——在下方添加你本地有、预设里没有的工具。'),
      React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 } },
        React.createElement('div', { style: { flex: '0 0 150px' } }, React.createElement(Input, { value: newName, placeholder: '名称（如 ksubdomain）', onChange: setNewName })),
        React.createElement('div', { style: { flex: 1 } }, React.createElement(Input, { value: newPath, placeholder: '工具路径（保存后进提示词，PATH 内可用）', onChange: setNewPath })),
        React.createElement('button', { type: 'button', style: btnStyle(false), onClick: addCustom }, '添加')),
      msg ? React.createElement('div', { style: msgStyle(false) }, msg) : null);
  }

  return React.createElement('div', null,
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      React.createElement('div', { style: groupTitleStyle() }, '本地工具库'),
      React.createElement('button', {
        type: 'button', disabled: scanning,
        style: { padding: '3px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: 'transparent', color: 'var(--dsw-alias-label-primary,#1a1a1a)' },
        onClick: scan,
      }, scanning ? '探测中…' : '重新探测')),
    React.createElement('div', { style: hintStyle() },
      '预设按分类列出，填路径即启用（保存后以 DSH_TOOL_<NAME> 注入 shell）。路径可手动粘贴，或在空行下点「自动探测到」的候选路径一键填入（宿主扫描已配工具目录自动发现同目录/同大类工具）。留空=不启用；「移除」从配置中删除。自定义工具名/路径经 PATH 或绝对路径调用。'),
    cand && cand.roots && cand.roots.length > 0
      ? React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', marginBottom: 8 } },
          '扫描根：' + cand.roots.join('  ·  ')) : null,
    presetGroups,
    customGroup);
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
    rpc(props.connection, 'settings/mutate', { ops: [{ op: 'set', path: ['tools'], value: v.tools }, { op: 'set', path: ['services'], value: v.services }, { op: 'set', path: ['dnslog'], value: v.dnslog }] }).then(function (res) {
      setBusy(false);
      if (res && res.ok) { setMsg('已保存'); props.onSaved && props.onSaved(); refreshStatus(); }
      else setMsg('保存失败：' + ((res && res.error && res.error.message) || '未知错误'));
    });
  }

  return React.createElement('div', null,
    React.createElement(ToolGroup, { connection: props.connection, value: v.tools || {}, onChange: function (next) { setPath(['tools'], next); } }),
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
