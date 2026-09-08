// dsh-method-stack — web client. 设置页「方法编排」tab（order 145）：
// 按 模式(preset) → 模块组 → 子方法 三层展示；勾选即改"当前模式启用组合"（下一轮模型
// 请求生效）；方法可克隆到用户层并编辑正文 / 还原官方；组合可另存与一键应用。
// 模型侧注入由 host 的 systemPrompt context('saker-methods') 完成，本页只改 profile。
window.__ModuleLoader__.load({ id: '@dsh-external/dsh-method-stack', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict';
var React = require('react');
var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;

var CHANNEL = '/dsh-method-stack';
function rpc(connection, endpoint, payload) {
  return connection.rpc.call(CHANNEL, endpoint, payload);
}
function h(style) { return style; }
var PRESETS = [
  { id: 'pentest', label: '渗透测试' },
  { id: 'code-audit', label: '代码审计' },
];
var GROUP_LABELS = { recon: '侦察', exploit: '攻击', evidence: '证据与复核', report: '报告', intranet: '内网' };
function groupLabel(g) { return (GROUP_LABELS[g] || g) + ' (' + g + ')'; }
function keyOf(group, id) { return group + '/' + id; }

function Toggle(props) {
  return React.createElement('input', { type: 'checkbox', checked: !!props.checked, onChange: props.onChange, style: { cursor: 'pointer' } });
}
function Btn(props) {
  return React.createElement('button', {
    type: 'button', disabled: props.disabled,
    style: { padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: props.disabled ? 'not-allowed' : 'pointer', border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: 'transparent', color: props.danger ? '#d1242f' : 'var(--dsw-alias-label-primary,#1a1a1a)', marginLeft: 4 },
    onClick: props.onClick,
  }, props.children);
}
function Modal(props) {
  if (!props.open) return null;
  return React.createElement('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
    React.createElement('div', { style: { width: 'min(720px, 90vw)', maxHeight: '86vh', overflow: 'auto', background: 'var(--dsw-alias-bg-base,#fff)', borderRadius: 10, padding: 16, border: '1px solid var(--dsw-alias-border-l1,#e4e4e7)' } }, props.children));
}

function MethodRow(props) {
  var m = props.m; var g = props.group; var k = keyOf(g, m.id);
  var [editing, setEditing] = useState(false);
  var [draft, setDraft] = useState('');
  var [savedMsg, setSavedMsg] = useState('');
  function openEdit() {
    setDraft(m.hasUser ? m.prompt || '' : '');
    setEditing(true); setSavedMsg('');
  }
  function save() {
    rpc(props.connection, 'save-prompt', { group: g, id: m.id, text: draft }).then(function (res) {
      setSavedMsg(res && res.ok ? '已保存（下一轮生效）' : ((res && res.error && res.error.message) || '保存失败'));
      if (res && res.ok) props.onChanged && props.onChanged();
    });
  }
  function clone() {
    rpc(props.connection, 'clone', { group: g, id: m.id }).then(function (res) {
      if (res && res.ok) props.onChanged && props.onChanged(); else alert((res && res.error && res.error.message) || '克隆失败');
    });
  }
  function restore() {
    rpc(props.connection, 'restore', { group: g, id: m.id }).then(function (res) {
      if (res && res.ok) props.onChanged && props.onChanged(); else alert((res && res.error && res.error.message) || '还原失败');
    });
  }
  var editBtn = m.hasUser
    ? React.createElement(Btn, { onClick: openEdit }, '编辑')
    : React.createElement(Btn, { onClick: clone }, '克隆编辑');
  var restoreBtn = m.hasUser ? React.createElement(Btn, { danger: true, onClick: restore }, '还原官方') : null;
  return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--dsw-alias-border-l2,#f0f0f2)' } },
    React.createElement(Toggle, { checked: m.active, onChange: function () { props.onToggle(k, !m.active); } }),
    React.createElement('div', { style: { flex: '0 0 150px', fontSize: 13, fontWeight: 600, fontFamily: 'ui-monospace, Consolas, monospace' } }, m.id),
    m.hasUser ? React.createElement('span', { style: { fontSize: 10, padding: '1px 6px', borderRadius: 999, background: '#dafbe1', color: '#1a7f37', fontWeight: 600 } }, '已自定义') : null,
    React.createElement('div', { style: { flex: 1, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#4a4a4f)', lineHeight: 1.5 } }, m.description),
    editBtn, restoreBtn,
    React.createElement(Modal, { open: editing },
      React.createElement('div', { style: { fontSize: 14, fontWeight: 700, marginBottom: 8 } }, '编辑方法：' + k + (m.hasUser ? '（用户版）' : '（先克隆到用户层）')),
      React.createElement('textarea', { value: draft, onChange: function (e) { setDraft(e.target.value); }, rows: 18, style: { width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, lineHeight: 1.6 } }),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } },
        React.createElement(Btn, { disabled: !m.hasUser, onClick: save }, '保存'),
        m.hasUser ? null : React.createElement(Btn, { onClick: function () { clone(); setEditing(false); } }, '克隆并继续编辑'),
        React.createElement('div', { style: { flex: 1 } }),
        React.createElement(Btn, { onClick: function () { setEditing(false); } }, '关闭')),
      savedMsg ? React.createElement('div', { style: { fontSize: 12, color: '#1a7f37', marginTop: 6 } }, savedMsg) : null));
}

function GroupSection(props) {
  var [open, setOpen] = useState(true);
  var allOn = props.group.methods.every(function (m) { return m.active; });
  return React.createElement('div', { style: { marginBottom: 10 } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }, onClick: function () { setOpen(!open); } },
      React.createElement('span', { style: { fontSize: 13, fontWeight: 700 } }, (open ? '▾' : '▸') + ' ' + groupLabel(props.group.group)),
      React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#6e6e73)' } },
        props.group.methods.filter(function (m) { return m.active; }).length + '/' + props.group.methods.length + ' 启用'),
      React.createElement('div', { style: { flex: 1 } }),
      React.createElement('a', { href: '#', style: { fontSize: 11 }, onClick: function (e) { e.preventDefault(); e.stopPropagation(); props.group.methods.forEach(function (m) { props.onToggle(keyOf(props.group.group, m.id), !allOn); }); } },
        allOn ? '整组停用' : '整组启用')),
    open ? props.group.methods.map(function (m) {
      return React.createElement(MethodRow, { key: m.id, m: m, group: props.group.group, connection: props.connection, onToggle: props.onToggle, onChanged: props.onChanged });
    }) : null);
}

function Page(props) {
  var [presetId, setPresetId] = useState('pentest');
  var [data, setData] = useState(null);
  var [comboName, setComboName] = useState('');
  var [msg, setMsg] = useState('');
  var [busy, setBusy] = useState(false);
  var [view, setView] = useState(null); // 预览正文
  function load(preset) {
    setData(null);
    rpc(props.connection, 'list', { presetId: preset }).then(function (res) {
      if (res && res.ok && res.value) setData(res.value); else setMsg('读取失败');
    }).catch(function () { setMsg('读取失败'); });
  }
  useEffect(function () { load(presetId); }, [presetId]);
  function setActive(nextActive) {
    setBusy(true);
    rpc(props.connection, 'set-active', { presetId: presetId, active: nextActive }).then(function (res) {
      setBusy(false);
      if (res && res.ok) load(presetId); else setMsg((res && res.error && res.error.message) || '保存失败');
    });
  }
  function toggle(key, on) {
    var cur = activeIds(data);
    var next = on ? cur.concat([key]) : cur.filter(function (x) { return x !== key; });
    setActive(next);
  }
  function saveCombo() {
    if (!comboName.trim()) return;
    rpc(props.connection, 'save-combo', { presetId: presetId, name: comboName.trim(), active: activeIds(data) }).then(function (res) {
      if (res && res.ok) { setComboName(''); load(presetId); } else setMsg((res && res.error && res.error.message) || '保存失败');
    });
  }
  function useCombo(name) {
    rpc(props.connection, 'use-combo', { presetId: presetId, name: name }).then(function (res) {
      if (res && res.ok) load(presetId); else setMsg((res && res.error && res.error.message) || '应用失败');
    });
  }
  if (!data) return React.createElement('div', { style: { fontSize: 13 } }, '加载中…');
  var combos = Object.keys(data.combos || {});
  return React.createElement('div', { style: { maxWidth: 760 } },
    React.createElement('div', { style: { fontSize: 13, fontWeight: 700, margin: '0 0 6px' } }, '方法编排'),
    React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', lineHeight: 1.7, marginBottom: 8 } },
      '按 模式→模块组→子方法 组织测试逻辑。勾选/取消即改变该模式的启用组合，' +
      '下一轮模型请求生效（注入段 <saker-methods>）；可把方法克隆到用户层自由编辑正文，或还原官方版本。' +
      '工具路径、MCP、知识库等配置不在这里（见安全配置/知识库）。'),
    React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 } },
      PRESETS.map(function (p) {
        return React.createElement(Btn, { key: p.id, onClick: function () { setPresetId(p.id); }, disabled: false,
          style: presetId === p.id ? { padding: '4px 12px', borderRadius: 6, fontSize: 12, background: '#2f81f7', color: '#fff', border: 'none', cursor: 'pointer' } : undefined }, p.label);
      }),
      React.createElement('div', { style: { flex: 1 } }),
      React.createElement(Btn, { onClick: function () { rpc(props.connection, 'render-preview', { presetId: presetId }).then(function (r) { if (r && r.ok) alert('将注入 ' + r.value.count + ' 个方法，正文约 ' + r.value.chars + ' 字符（rev ' + r.value.rev + '）'); }); } }, '注入预览'),
      busy ? React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#6e6e73)' } }, '保存中…') : null),
    data.groups.map(function (g) { return React.createElement(GroupSection, { key: g.group, group: g, connection: props.connection, onToggle: toggle, onChanged: function () { load(presetId); } }); }),
    React.createElement('div', { style: { marginTop: 10, borderTop: '1px solid var(--dsw-alias-border-l2,#e4e4e7)', paddingTop: 10 } },
      React.createElement('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 6 } }, '组合'),
      React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
        React.createElement('input', { value: comboName, onChange: function (e) { setComboName(e.target.value); }, placeholder: '组合名（如“只做侦察”）', style: { padding: '5px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', fontSize: 12 } }),
        React.createElement(Btn, { onClick: saveCombo }, '另存当前勾选为组合'),
        combos.map(function (name) {
          return React.createElement('span', { key: name, style: { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--dsw-alias-bg-layer-2,#f2f2f4)', border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', borderRadius: 999, padding: '2px 10px', fontSize: 12 } },
            name,
            React.createElement('a', { href: '#', style: { color: '#2f81f7', fontSize: 11, textDecoration: 'none' }, onClick: function (e) { e.preventDefault(); useCombo(name); } }, '应用'));
        })),
      msg ? React.createElement('div', { style: { fontSize: 12, color: '#d1242f', marginTop: 6 } }, msg) : null));
}

function activeIds(data) {
  var out = [];
  (data.groups || []).forEach(function (g) { g.methods.forEach(function (m) { if (m.active) out.push(keyOf(g.group, m.id)); }); });
  return out;
}

function apply(ctx) {
  ctx.slots.inject('settings.section', function () {
    return ctx.slots.register({
      name: 'settings.section', id: 'method-stack', order: 145,
      label: function () { return '方法编排'; },
    }, function () { return React.createElement(Page, { connection: ctx.connection }); });
  });
}

module.exports = { name: 'dsh-method-stack-client', inject: ['slots', 'connection'], apply: apply };
return module.exports; } });
