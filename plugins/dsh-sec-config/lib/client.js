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

var TOOL_KEYS = ['sqlmap', 'nuclei', 'dirsearch', 'fscan', 'subfinder', 'httpx', 'katana', 'afrog', 'ffuf', 'jwt_tool', 'nmap'];
var TOOL_LABELS = { sqlmap: 'SQLMap', nuclei: 'Nuclei', dirsearch: 'Dirsearch', fscan: 'Fscan', subfinder: 'Subfinder', httpx: 'Httpx', katana: 'Katana', afrog: 'Afrog', ffuf: 'Ffuf', jwt_tool: 'JWT Tool', nmap: 'Nmap' };

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
    rpc(props.connection, 'settings/mutate', { ops: [{ op: 'set', path: ['tools'], value: v.tools }, { op: 'set', path: ['services'], value: v.services }, { op: 'set', path: ['dnslog'], value: v.dnslog }, { op: 'set', path: ['apiKeys'], value: v.apiKeys }] }).then(function (res) {
      setBusy(false);
      if (res && res.ok) { setMsg('已保存'); props.onSaved && props.onSaved(); refreshStatus(); }
      else setMsg('保存失败：' + ((res && res.error && res.error.message) || '未知错误'));
    });
  }

  return React.createElement('div', null,
    React.createElement(Group, { title: '本地工具路径（供渗透/审计 playbook 定位，留空表示未安装）' },
      TOOL_KEYS.map(function (k) {
        return React.createElement('div', { key: k },
          React.createElement('label', { style: labelStyle() }, TOOL_LABELS[k] || k),
          React.createElement(Input, { value: tools[k] || '', placeholder: '例如 E:\\tools\\' + k + '.exe', onChange: function (val) { setPath(['tools', k], val); } }));
      })),
    React.createElement(Group, { title: '服务连接地址（保存后自动同步到 MCP 工作台，模型立即可见）' },
      React.createElement(ServiceRow, { connection: props.connection, name: 'burp', label: 'Burp Suite 地址', placeholder: 'http://127.0.0.1:9876', value: services.burpUrl || '', status: mountStatus.burp, mounting: mountingName === 'burp', onChange: function (val) { setPath(['services', 'burpUrl'], val); }, onMount: mountOne.bind(null, 'burp') }),
      React.createElement(ServiceRow, { connection: props.connection, name: 'yakit', label: 'Yakit 地址', placeholder: 'http://127.0.0.1:11432', value: services.yakitUrl || '', status: mountStatus.yakit, mounting: mountingName === 'yakit', onChange: function (val) { setPath(['services', 'yakitUrl'], val); }, onMount: mountOne.bind(null, 'yakit') })),
    React.createElement(Group, { title: 'DNSLog 平台' },
      React.createElement('label', { style: labelStyle() }, '平台地址'),
      React.createElement(Input, { value: dnslog.url || '', placeholder: 'http://ceye.io', onChange: function (val) { setPath(['dnslog', 'url'], val); } }),
      React.createElement('label', { style: labelStyle() }, 'Token（保存后仅显示 ***）'),
      React.createElement(Input, { type: 'password', value: dnslog.token || '', placeholder: dnslog.token === '***' ? '已设置，留空保持不变' : 'dnslog token', onChange: function (val) { setPath(['dnslog', 'token'], val); } })),
    React.createElement(Group, { title: 'API 密钥' },
      React.createElement('label', { style: labelStyle() }, 'DeepSeek API Key（保存后仅显示 ***）'),
      React.createElement(Input, { type: 'password', value: apiKeys.deepseekKey || '', placeholder: apiKeys.deepseekKey === '***' ? '已设置，留空保持不变' : 'sk-...', onChange: function (val) { setPath(['apiKeys', 'deepseekKey'], val); } })),
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
