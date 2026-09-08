// dsh-method-stack — web client.
// 1) 设置页「方法编排」tab（order 145）：模式 → 模块组 → 子方法；勾选改启用组合、
//    克隆编辑/还原、组合另存应用、注入预览。
// 2) 会话聊天输入框下方 dock（conversation.composer.dock）：当前模式启用的方法 pills，
//    点 pill 即停用、点「+」展开该模式全部方法勾选——快捷点选，下一轮生效。
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

// ── 会话输入框 dock：快捷点选当前模式方法 ─────────────────────────────────
// 用与 mode-group 相同的方式取"当前会话模式"：订阅 remote 'agent-preset/selected'
// 与 sessions noteAgentPreset。组件不依赖宿主注入 face 的细节，只从共享 store 读。

var presetStore = { current: 'pentest', listeners: [] };
function setCurrentPreset(id) {
  if (!id || id === presetStore.current) return;
  presetStore.current = id;
  presetStore.listeners.forEach(function (l) { try { l(id); } catch (e) { /* ignore */ } });
}
function useCurrentPreset() {
  var [p, setP] = useState(presetStore.current);
  useEffect(function () {
    var l = function (id) { setP(id); };
    presetStore.listeners.push(l);
    setP(presetStore.current);
    return function () {
      var i = presetStore.listeners.indexOf(l);
      if (i >= 0) presetStore.listeners.splice(i, 1);
    };
  }, []);
  return p;
}

var pillStyle = function (on, danger) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 999,
    padding: '1px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer', userSelect: 'none',
    border: on ? '1px solid #2f81f7' : '1px solid var(--dsw-alias-border-l1,#d9d9de)',
    background: on ? '#eaf2fe' : 'var(--dsw-alias-bg-layer-2,#f6f6f7)',
    color: on ? '#175cd3' : 'var(--dsw-alias-label-tertiary,#6e6e73)',
  };
};

/** dock 内嵌弹层：当前模式的组 → 方法勾选（复选 toggle）。 */
function MethodPalette(props) {
  var [open, setOpen] = useState(false);
  var ref = useRef(null);
  useEffect(function () {
    if (!open) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return function () { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return React.createElement('span', { ref: ref, style: { position: 'relative', display: 'inline-block' } },
    React.createElement('button', { type: 'button', onClick: function () { setOpen(!open); }, style: pillStyle(true, false) }, '＋ 方法'),
    open ? React.createElement('div', { style: { position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, zIndex: 500, width: 320, maxHeight: 320, overflow: 'auto', background: 'var(--dsw-alias-bg-base,#fff)', border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', borderRadius: 8, padding: 8, boxShadow: '0 6px 24px rgba(0,0,0,0.14)' } },
      (props.groups || []).map(function (g) {
        return React.createElement('div', { key: g.group, style: { marginBottom: 6 } },
          React.createElement('div', { style: { fontSize: 12, fontWeight: 700, margin: '2px 0 4px' } }, groupLabel(g.group)),
          g.methods.map(function (m) {
            var k = keyOf(g.group, m.id);
            return React.createElement('label', { key: k, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '2px 2px', cursor: 'pointer' } },
              React.createElement('input', { type: 'checkbox', checked: m.active, onChange: function () { props.onToggle(k, !m.active); } }),
              React.createElement('span', { style: { fontWeight: m.active ? 600 : 400, fontFamily: 'ui-monospace, Consolas, monospace' } }, m.id));
          }));
      })) : null);
}

/** 输入框下方 dock：当前模式 + 启用方法 pills（点 pill 停用）＋「方法」调色板。 */
function MethodDock(props) {
  var preset = useCurrentPreset();
  var [data, setData] = useState(null);
  var [busy, setBusy] = useState(false);
  function load(p) {
    rpc(props.connection, 'list', { presetId: p }).then(function (res) {
      if (res && res.ok && res.value) setData(res.value);
    }).catch(function () { /* 静默 */ });
  }
  useEffect(function () { load(preset); }, [preset]);
  function toggle(key, on) {
    var cur = [];
    (data.groups || []).forEach(function (g) { g.methods.forEach(function (m) { if (m.active) cur.push(keyOf(g.group, m.id)); }); });
    var next = on ? cur.concat([key]) : cur.filter(function (x) { return x !== key; });
    setBusy(true);
    rpc(props.connection, 'set-active', { presetId: preset, active: next }).then(function (r) {
      setBusy(false);
      if (r && r.ok) load(preset);
    }).catch(function () { setBusy(false); });
  }
  if (!data) return null;
  var activeMethods = [];
  var allMethods = [];
  (data.groups || []).forEach(function (g) {
    g.methods.forEach(function (m) {
      allMethods.push({ g: g.group, m: m });
      if (m.active) activeMethods.push({ g: g.group, m: m });
    });
  });
  var presetMeta = PRESETS.find(function (x) { return x.id === preset; });
  return React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, padding: '4px 2px', fontSize: 11 } },
    React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary,#6e6e73)', marginRight: 2, whiteSpace: 'nowrap' } },
      (presetMeta ? presetMeta.label + '·' : '') + '方法 ' + activeMethods.length),
    activeMethods.slice(0, 12).map(function (x) {
      return React.createElement('button', {
        key: keyOf(x.g, x.m.id), type: 'button', title: '停用 ' + x.m.id + '（下一轮不再注入）',
        style: pillStyle(true, false), onClick: function () { toggle(keyOf(x.g, x.m.id), false); },
      }, x.m.id + ' ✕');
    }),
    activeMethods.length > 12 ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary,#6e6e73)' } }, '…') : null,
    React.createElement(MethodPalette, { groups: data.groups, onToggle: toggle }),
    busy ? React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary,#6e6e73)' } }, '…') : null);
}

function apply(ctx) {
  // 共享 store 订阅：当前会话模式（照 mode-group 从 remote 事件 + sessions 记录）。
  try {
    var remote = ctx.remote;
    if (remote && typeof remote.$on === 'function') {
      remote.$on('agent-preset/selected', function (sid, agentPreset) {
        if (agentPreset) setCurrentPreset(agentPreset);
      });
    }
    var sessions = ctx.sessions;
    if (sessions && sessions.list && sessions.list.getSnapshot) {
      try {
        var snap = sessions.list.getSnapshot();
        var byId = snap.byId || snap;
        var ids = Object.keys(byId || {});
        for (var i = 0; i < ids.length; i++) {
          var s = byId[ids[i]];
          if (s && s.agentPreset) { setCurrentPreset(s.agentPreset); break; }
        }
      } catch (e) { /* 快照形态差异时跳过 */ }
    }
  } catch (e) { /* 订阅失败不阻塞 */ }

  ctx.slots.inject('settings.section', function () {
    return ctx.slots.register({
      name: 'settings.section', id: 'method-stack', order: 145,
      label: function () { return '方法编排'; },
    }, function () { return React.createElement(Page, { connection: ctx.connection }); });
  });

  // 聊天输入框下方 dock 快捷点选。
  try {
    ctx.slots.inject('conversation.composer.dock', function () {
      return ctx.slots.register({
        name: 'conversation.composer.dock', id: 'method-stack', order: 20,
      }, function () { return React.createElement(MethodDock, { connection: ctx.connection }); });
    });
  } catch (e) { /* composer 槽不可用时仅保留设置页 */ }
}

module.exports = { name: 'dsh-method-stack-client', inject: ['slots', 'connection', 'remote', 'sessions'], apply: apply };
return module.exports; } });
