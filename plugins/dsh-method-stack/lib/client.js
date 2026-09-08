// dsh-method-stack — web client.
// 1) 设置页「方法编排」（order 145）：模式 → 模块组 → 子方法；勾选=启用；点「查看/自定义」
//    弹窗显示当前生效正文（官方或用户版），编辑即自动派生到用户层保存（透明、可还原）。
// 2) 会话输入框 dock：紧凑「方法 ▾」按钮 → 分层浮层：组合（另存/应用）+ 组多选/仅此组/子方法。
// 模型侧注入由 host systemPrompt context('saker-methods') 完成。
window.__ModuleLoader__.load({ id: '@dsh-external/dsh-method-stack', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict';
var React = require('react');
var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;

var CHANNEL = '/dsh-method-stack';
function rpc(connection, endpoint, payload) {
  return connection.rpc.call(CHANNEL, endpoint, payload);
}
var PRESETS = [
  { id: 'pentest', label: '渗透测试' },
  { id: 'code-audit', label: '代码审计' },
];
var GROUP_LABELS = { recon: '侦察', exploit: '攻击', evidence: '证据与复核', report: '报告', intranet: '内网' };
function groupLabel(g) { return (GROUP_LABELS[g] || g) + ' · ' + g; }
function keyOf(group, id) { return group + '/' + id; }

function Btn(props) {
  return React.createElement('button', {
    type: 'button', disabled: props.disabled,
    style: props.style || {
      padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: props.disabled ? 'not-allowed' : 'pointer',
      border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: 'transparent',
      color: props.danger ? '#d1242f' : 'var(--dsw-alias-label-primary,#1a1a1a)', marginLeft: 4,
    },
    onClick: props.onClick, title: props.title,
  }, props.children);
}
function Modal(props) {
  if (!props.open) return null;
  return React.createElement('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
    React.createElement('div', { style: { width: 'min(760px, 92vw)', maxHeight: '88vh', overflow: 'auto', background: 'var(--dsw-alias-bg-base,#fff)', borderRadius: 10, padding: 16, border: '1px solid var(--dsw-alias-border-l1,#e4e4e7)' } }, props.children));
}
function iconBtn(text, title, onClick, primary) {
  return React.createElement('button', {
    type: 'button', title: title,
    style: { padding: '1px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (primary ? '#2f81f7' : 'var(--dsw-alias-border-l1,#d9d9de)'), background: primary ? '#2f81f7' : 'transparent', color: primary ? '#fff' : 'var(--dsw-alias-label-primary,#1a1a1a)', whiteSpace: 'nowrap' },
    onClick: onClick,
  }, text);
}

// ── 方法行（设置页）─────────────────────────────────────────────────────────
function MethodRow(props) {
  var m = props.m, g = props.group, k = keyOf(g, m.id);
  var [open, setOpen] = useState(false);
  var [draft, setDraft] = useState('');
  var [msg, setMsg] = useState('');
  var [dirty, setDirty] = useState(false);
  function openModal() {
    // 透明：编辑框始终预填当前生效正文（官方或用户版）
    setDraft(m.prompt || '');
    setDirty(false); setMsg('');
    setOpen(true);
  }
  function save() {
    rpc(props.connection, 'save-prompt', { group: g, id: m.id, text: draft }).then(function (res) {
      if (res && res.ok) {
        setMsg('已保存（派生到用户层，下一轮生效）');
        setDirty(false);
        props.onChanged && props.onChanged();
      } else {
        setMsg((res && res.error && res.error.message) || '保存失败');
      }
    });
  }
  function restore() {
    rpc(props.connection, 'restore', { group: g, id: m.id }).then(function (res) {
      if (res && res.ok) { props.onChanged && props.onChanged(); setOpen(false); } else alert((res && res.error && res.error.message) || '还原失败');
    });
  }
  var row = React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--dsw-alias-border-l2,#f0f0f2)' } },
    React.createElement('input', { type: 'checkbox', checked: !!m.active, onChange: function () { props.onToggle(k, !m.active); }, style: { cursor: 'pointer' } }),
    React.createElement('div', { style: { flex: '0 0 165px', fontSize: 13, fontWeight: 600, fontFamily: 'ui-monospace, Consolas, monospace' } }, m.id),
    m.hasUser ? React.createElement('span', { style: { fontSize: 10, padding: '1px 6px', borderRadius: 999, background: '#dafbe1', color: '#1a7f37', fontWeight: 600 } }, '已自定义') : null,
    React.createElement('div', { style: { flex: 1, fontSize: 12, color: 'var(--dsw-alias-label-secondary,#4a4a4f)', lineHeight: 1.5 } }, m.description),
    iconBtn(m.hasUser ? '编辑' : '查看/自定义', '查看当前正文；编辑即派生到用户层（官方版本不受影响）', openModal),
    m.hasUser ? iconBtn('还原官方', '放弃用户版，恢复官方默认', restore) : null);
  var editor = React.createElement(Modal, { open: open },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      React.createElement('div', { style: { fontSize: 14, fontWeight: 700 } }, '方法正文：' + k),
      m.hasUser
        ? React.createElement('span', { style: { fontSize: 11, padding: '1px 7px', borderRadius: 999, background: '#dafbe1', color: '#1a7f37', fontWeight: 600 } }, '用户版（编辑它；还原官方可恢复）')
        : React.createElement('span', { style: { fontSize: 11, padding: '1px 7px', borderRadius: 999, background: '#eef2f6', color: '#4a5568', fontWeight: 600 } }, '官方版 · 保存将自动派生到用户层')),
    React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', margin: '6px 0' } }, '正文即注入模型的指令。可含 {{变量}}。修改只影响该方法，工具/知识库配置不受影响。'),
    React.createElement('textarea', { value: draft, onChange: function (e) { setDraft(e.target.value); setDirty(true); }, rows: 20, style: { width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, lineHeight: 1.6 } }),
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } },
      React.createElement(Btn, { onClick: save }, '保存'),
      React.createElement('div', { style: { flex: 1 } }),
      dirty ? React.createElement('span', { style: { fontSize: 11, color: '#d97706' } }, '未保存') : null,
      React.createElement(Btn, { onClick: function () { setOpen(false); } }, '关闭')),
    msg ? React.createElement('div', { style: { fontSize: 12, color: msg.indexOf('失败') >= 0 ? '#d1242f' : '#1a7f37', marginTop: 6 } }, msg) : null);
  return React.createElement('div', null, row, editor);
}

function GroupSection(props) {
  var [open, setOpen] = useState(true);
  var on = props.group.methods.filter(function (m) { return m.active; }).length;
  var total = props.group.methods.length;
  var allOn = on === total;
  return React.createElement('div', { style: { marginBottom: 8 } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none', padding: '4px 0' }, onClick: function () { setOpen(!open); } },
      React.createElement('span', { style: { fontSize: 13, fontWeight: 700 } }, (open ? '▾' : '▸') + ' ' + groupLabel(props.group.group)),
      React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#6e6e73)' } }, on + '/' + total),
      React.createElement('div', { style: { flex: 1 } }),
      React.createElement('span', { onClick: function (e) { e.preventDefault(); e.stopPropagation(); props.onToggleGroup(props.group.group, !allOn); }, style: { fontSize: 11, color: '#2f81f7', cursor: 'pointer' } }, allOn ? '整组停用' : '整组启用')),
    open ? props.group.methods.map(function (m) {
      return React.createElement(MethodRow, { key: m.id, m: m, group: props.group.group, connection: props.connection, onToggle: props.onToggle, onChanged: props.onChanged });
    }) : null);
}

// ── 设置页 Page ─────────────────────────────────────────────────────────────
function Page(props) {
  var [presetId, setPresetId] = useState('pentest');
  var [data, setData] = useState(null);
  var [comboName, setComboName] = useState('');
  var [msg, setMsg] = useState('');
  function load(preset) {
    setData(null);
    rpc(props.connection, 'list', { presetId: preset }).then(function (res) {
      if (res && res.ok && res.value) setData(res.value); else setMsg('读取失败');
    }).catch(function () { setMsg('读取失败'); });
  }
  useEffect(function () { load(presetId); }, [presetId]);
  function setActive(next) {
    rpc(props.connection, 'set-active', { presetId: presetId, active: next }).then(function (r) {
      if (r && r.ok) load(presetId); else setMsg((r && r.error && r.error.message) || '保存失败');
    });
  }
  function toggle(k, on) { var cur = activeIds(data); setActive(on ? cur.concat([k]) : cur.filter(function (x) { return x !== k; })); }
  function toggleGroup(g, on) {
    var cur = activeIds(data).filter(function (x) { return x.split('/')[0] !== g; });
    var gAll = [];
    (data.groups || []).forEach(function (gr) { if (gr.group === g) gr.methods.forEach(function (m) { gAll.push(keyOf(g, m.id)); }); });
    setActive(on ? cur.concat(gAll) : cur);
  }
  function saveCombo() {
    if (!comboName.trim()) return;
    rpc(props.connection, 'save-combo', { presetId: presetId, name: comboName.trim(), active: activeIds(data) }).then(function (r) {
      if (r && r.ok) { setComboName(''); load(presetId); } else setMsg((r && r.error && r.error.message) || '保存失败');
    });
  }
  function useCombo(name) {
    rpc(props.connection, 'use-combo', { presetId: presetId, name: name }).then(function (r) {
      if (r && r.ok) load(presetId); else setMsg((r && r.error && r.error.message) || '应用失败');
    });
  }
  if (!data) return React.createElement('div', { style: { fontSize: 13 } }, '加载中…');
  var combos = Object.keys(data.combos || {});
  return React.createElement('div', { style: { maxWidth: 780 } },
    React.createElement('div', { style: { fontSize: 14, fontWeight: 700, margin: '0 0 4px' } }, '方法编排'),
    React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', lineHeight: 1.7, marginBottom: 8 } },
      '按 模式 → 模块组 → 子方法 组织测试逻辑。勾选=该模式启用（下一轮请求注入 <saker-methods>）。' +
      '点「查看/自定义」可看并编辑正文——编辑自动派生到用户层，官方版本保留可还原。' +
      '工具路径、MCP、知识库等配置不在此（见安全配置/知识库）。'),
    React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' } },
      PRESETS.map(function (p) {
        var active = presetId === p.id;
        return React.createElement('button', { key: p.id, type: 'button', onClick: function () { setPresetId(p.id); },
          style: { padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', border: 'none', background: active ? '#2f81f7' : 'var(--dsw-alias-bg-layer-2,#eef0f3)', color: active ? '#fff' : 'var(--dsw-alias-label-primary,#1a1a1a)' } }, p.label);
      }),
      React.createElement('div', { style: { flex: 1 } }),
      React.createElement(Btn, { onClick: function () { rpc(props.connection, 'render-preview', { presetId: presetId }).then(function (r) { if (r && r.ok) alert('将注入 ' + r.value.count + ' 个方法，正文约 ' + r.value.chars + ' 字符（rev ' + r.value.rev + '）'); }); } }, '注入预览')),
    data.groups.map(function (g) { return React.createElement(GroupSection, { key: g.group, group: g, connection: props.connection, onToggle: toggle, onToggleGroup: toggleGroup, onChanged: function () { load(presetId); } }); }),
    React.createElement('div', { style: { marginTop: 10, borderTop: '1px solid var(--dsw-alias-border-l2,#e4e4e7)', paddingTop: 10 } },
      React.createElement('div', { style: { fontSize: 13, fontWeight: 700, marginBottom: 6 } }, '组合'),
      React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
        React.createElement('input', { value: comboName, onChange: function (e) { setComboName(e.target.value); }, placeholder: '组合名（如 只做侦察）', style: { padding: '5px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', fontSize: 12 } }),
        React.createElement(Btn, { onClick: saveCombo }, '另存为组合'),
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

// ── 会话输入框 dock：分层浮层菜单（组合 + 组多选 + 仅此组 + 子方法）────────
var presetStore = { current: 'pentest', listeners: [] };
function setCurrentPreset(id) { if (!id || id === presetStore.current) return; presetStore.current = id; presetStore.listeners.forEach(function (l) { try { l(id); } catch (e) { /* ignore */ } }); }
function useCurrentPreset() {
  var [p, setP] = useState(presetStore.current);
  useEffect(function () {
    var l = function (id) { setP(id); };
    presetStore.listeners.push(l); setP(presetStore.current);
    return function () { var i = presetStore.listeners.indexOf(l); if (i >= 0) presetStore.listeners.splice(i, 1); };
  }, []);
  return p;
}

function MethodDock(props) {
  var preset = useCurrentPreset();
  var [data, setData] = useState(null);
  var [open, setOpen] = useState(false);
  var [comboName, setComboName] = useState('');
  var ref = useRef(null);
  function load(p) { rpc(props.connection, 'list', { presetId: p }).then(function (res) { if (res && res.ok && res.value) setData(res.value); }).catch(function () { /* 静默 */ }); }
  useEffect(function () { load(preset); }, [preset]);
  useEffect(function () {
    if (!open) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return function () { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  if (!data) return null;
  var activeCount = 0;
  (data.groups || []).forEach(function (g) { g.methods.forEach(function (m) { if (m.active) activeCount++; }); });
  var presetMeta = PRESETS.find(function (x) { return x.id === preset; });
  function commit(next) {
    rpc(props.connection, 'set-active', { presetId: preset, active: next }).then(function (r) { if (r && r.ok) load(preset); });
  }
  function toggle(k, on) {
    var cur = activeIds(data);
    commit(on ? cur.concat([k]) : cur.filter(function (x) { return x !== k; }));
  }
  function toggleGroupOnly(g) {
    var next = activeIds(data).filter(function (x) { return x.split('/')[0] !== g; });
    (data.groups || []).forEach(function (gr) { if (gr.group === g) gr.methods.forEach(function (m) { next.push(keyOf(g, m.id)); }); });
    commit(next);
  }
  function useCombo(name) { rpc(props.connection, 'use-combo', { presetId: preset, name: name }).then(function (r) { if (r && r.ok) load(preset); }); }
  function saveCombo() { if (!comboName.trim()) return; rpc(props.connection, 'save-combo', { presetId: preset, name: comboName.trim(), active: activeIds(data) }).then(function (r) { if (r && r.ok) { setComboName(''); load(preset); } }); }
  var combos = Object.keys(data.combos || {});
  return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', fontSize: 12 }, ref: ref },
    React.createElement('button', {
      type: 'button', onClick: function () { setOpen(!open); },
      style: { display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999, padding: '2px 10px', fontSize: 12, cursor: 'pointer', border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: 'var(--dsw-alias-bg-base,#fff)', color: 'var(--dsw-alias-label-primary,#1a1a1a)' },
    }, '方法 ▾', React.createElement('span', { style: { fontSize: 11, fontWeight: 700, color: '#2f81f7' } }, (presetMeta ? presetMeta.label + ' ' : '') + activeCount)),
    open ? React.createElement('div', { style: { position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 600, width: 400, maxHeight: '70vh', overflow: 'auto', background: 'var(--dsw-alias-bg-base,#fff)', border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', borderRadius: 10, padding: 10, boxShadow: '0 10px 32px rgba(0,0,0,0.18)' } },
      React.createElement('div', { style: { fontSize: 12, fontWeight: 700, marginBottom: 6, color: 'var(--dsw-alias-label-primary,#1a1a1a)' } }, '方法组合 · ' + (presetMeta ? presetMeta.label : preset)),
      combos.length ? React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 } },
        combos.map(function (name) {
          return React.createElement('button', { key: name, type: 'button', onClick: function () { useCombo(name); }, style: { padding: '1px 9px', borderRadius: 999, fontSize: 11, border: '1px solid #2f81f7', background: '#eaf2fe', color: '#175cd3', cursor: 'pointer' } }, '组合：' + name);
        })) : null,
      React.createElement('div', { style: { display: 'flex', gap: 4, marginBottom: 8 } },
        React.createElement('input', { value: comboName, onChange: function (e) { setComboName(e.target.value); }, placeholder: '另存当前勾选为组合…', style: { flex: 1, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', fontSize: 12 } }),
        React.createElement(Btn, { onClick: saveCombo }, '另存')),
      (data.groups || []).map(function (g) {
        var on = g.methods.filter(function (m) { return m.active; }).length;
        return React.createElement('div', { key: g.group, style: { marginBottom: 4 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', fontSize: 12, fontWeight: 700, padding: '3px 0', color: 'var(--dsw-alias-label-primary,#1a1a1a)' } },
            groupLabel(g.group),
            React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', fontWeight: 400 } }, ' ' + on + '/' + g.methods.length),
            React.createElement('div', { style: { flex: 1 } }),
            React.createElement('a', { href: '#', style: { fontSize: 11, color: '#2f81f7', textDecoration: 'none', fontWeight: 400 }, onClick: function (e) { e.preventDefault(); toggleGroupOnly(g.group); } }, '仅此组')),
          g.methods.map(function (m) {
            var k = keyOf(g.group, m.id);
            return React.createElement('label', { key: k, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '2px 2px', cursor: 'pointer' } },
              React.createElement('input', { type: 'checkbox', checked: m.active, onChange: function () { toggle(k, !m.active); } }),
              React.createElement('span', { style: { fontFamily: 'ui-monospace, Consolas, monospace', fontWeight: m.active ? 600 : 400 } }, m.id),
              React.createElement('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, ' ' + (m.description || '').slice(0, 60)));
          }));
      }),
      React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#6e6e73)', marginTop: 6 } }, '变更在下一轮模型请求生效；完整自定义见 设置 → 方法编排。'))
      : null);
}

function apply(ctx) {
  try {
    var remote = ctx.remote;
    if (remote && typeof remote.$on === 'function') {
      remote.$on('agent-preset/selected', function (sid, agentPreset) { if (agentPreset) setCurrentPreset(agentPreset); });
    }
    var sessions = ctx.sessions;
    if (sessions && sessions.list && sessions.list.getSnapshot) {
      try {
        var snap = sessions.list.getSnapshot(); var byId = snap.byId || snap; var ids = Object.keys(byId || {});
        for (var i = 0; i < ids.length; i++) { var s = byId[ids[i]]; if (s && s.agentPreset) { setCurrentPreset(s.agentPreset); break; } }
      } catch (e) { /* 快照形态差异跳过 */ }
    }
  } catch (e) { /* 订阅失败不阻塞 */ }

  ctx.slots.inject('settings.section', function () {
    return ctx.slots.register({ name: 'settings.section', id: 'method-stack', order: 145, label: function () { return '方法编排'; } },
      function () { return React.createElement(Page, { connection: ctx.connection }); });
  });
  try {
    ctx.slots.inject('conversation.composer.dock', function () {
      return ctx.slots.register({ name: 'conversation.composer.dock', id: 'method-stack', order: 20 },
        function () { return React.createElement(MethodDock, { connection: ctx.connection }); });
    });
  } catch (e) { /* composer 槽不可用时仅保留设置页 */ }
}

module.exports = { name: 'dsh-method-stack-client', inject: ['slots', 'connection', 'remote', 'sessions'], apply: apply };
return module.exports; } });
