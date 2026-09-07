// dsh-skill-browse — web client.
// 在「设置」中加一页「技能」：列出当前可引用的所有技能（共享 + 当前预设），
// 提供一键复制 @skill:<name> 到剪贴板；底部给出 prompt 引用语法提示。
// 「安装市场技能」按钮先调用 install-skill，宿主若未实现则回退提示。
window.__ModuleLoader__.load({ id: '@dsh-external/dsh-skill-browse', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict';
var React = require('react');
var useState = React.useState, useEffect = React.useEffect;

var CHANNEL = '/dsh-skill-browse';

function rpc(connection, endpoint, payload) {
  return connection.rpc.call(CHANNEL, endpoint, payload);
}

function fieldStyle() { return { display: 'block', width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1, #d9d9de)', background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-label-primary, #1a1a1a)', fontSize: 13, boxSizing: 'border-box' }; }
function groupStyle() { return { marginBottom: 18 }; }
function groupTitleStyle() { return { fontSize: 13, fontWeight: 600, margin: '0 0 4px', color: 'var(--dsw-alias-label-primary, #1a1a1a)' }; }
function btnStyle(primary) { return { padding: '8px 16px', borderRadius: 6, border: '1px solid ' + (primary ? 'transparent' : 'var(--dsw-alias-border-l1,#d9d9de)'), background: primary ? '#2f81f7' : 'transparent', color: primary ? '#fff' : 'var(--dsw-alias-label-primary,#1a1a1a)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }; }
function msgStyle(ok) { return { marginTop: 8, fontSize: 12, color: ok ? '#1a7f37' : '#d1242f' }; }
function hintStyle() { return { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #6e6e73)', marginBottom: 6, lineHeight: 1.6 }; }

function CopyButton(props) {
  var [state, setState] = useState('idle'); // idle | copied | failed
  function copy() {
    var text = '@skill:' + props.name;
    var done = function () { setState('copied'); setTimeout(function () { setState('idle'); }, 1500); };
    var fail = function () { setState('failed'); setTimeout(function () { setState('idle'); }, 2000); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) done(); else fail();
      } catch (e) { fail(); }
    }
  }
  var label = state === 'copied' ? '已复制' : (state === 'failed' ? '复制失败' : '复制 @skill:' + props.name);
  var bg = state === 'copied' ? '#dafbe1' : (state === 'failed' ? '#ffebe9' : 'transparent');
  var fg = state === 'copied' ? '#1a7f37' : (state === 'failed' ? '#d1242f' : '#2f81f7');
  return React.createElement('button', {
    type: 'button',
    onClick: copy,
    style: { padding: '4px 10px', fontSize: 12, borderRadius: 6, border: '1px solid ' + (state === 'idle' ? '#2f81f7' : 'transparent'), background: bg, color: fg, cursor: 'pointer', flex: '0 0 auto' },
  }, label);
}

function SkillRow(props) {
  var skill = props.skill;
  return React.createElement('div', { style: { padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', borderRadius: 8, marginBottom: 8, background: 'var(--dsw-alias-bg-base,#fff)' } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
      React.createElement('span', { style: { fontWeight: 600, fontSize: 13 } }, skill.name),
      React.createElement('span', { style: { fontSize: 10, padding: '1px 6px', borderRadius: 999, background: skill.origin === 'shared' ? '#e0f2fe' : '#fef3c7', color: skill.origin === 'shared' ? '#075985' : '#92400e', fontWeight: 600 } }, skill.origin),
      React.createElement('div', { style: { flex: 1 } }),
      React.createElement(CopyButton, { name: skill.name })),
    skill.description ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary,#4a4a4f)', lineHeight: 1.55 } }, skill.description) : null);
}

function InstallButton(props) {
  var [busy, setBusy] = useState(false);
  var [msg, setMsg] = useState(null);
  function click() {
    setBusy(true); setMsg(null);
    rpc(props.connection, 'install-skill', {}).then(function (res) {
      setBusy(false);
      if (res && res.ok && res.value && res.value.installed) {
        setMsg({ ok: true, text: '已安装' });
      } else {
        setMsg({ ok: false, text: (res && res.value && res.value.reason) || '市场安装未启用' });
      }
    }).catch(function (e) { setBusy(false); setMsg({ ok: false, text: String(e && e.message || e) }); });
  }
  return React.createElement('div', null,
    React.createElement('button', { type: 'button', style: btnStyle(false), onClick: click, disabled: busy }, busy ? '请求中…' : '从市场安装技能'),
    msg ? React.createElement('div', { style: msgStyle(msg.ok) }, msg.text) : null);
}

function Page(props) {
  var [state, setState] = useState({ status: 'loading', skills: [] });
  var [presetId, setPresetId] = useState('');

  function load() {
    rpc(props.connection, 'list', { presetId: presetId }).then(function (res) {
      if (res && res.ok && res.value && Array.isArray(res.value.skills)) {
        setState({ status: 'ready', skills: res.value.skills });
      } else {
        setState({ status: 'error', skills: [] });
      }
    });
  }
  useEffect(load, [presetId]);

  return React.createElement('div', null,
    React.createElement('div', { style: { fontSize: 13, fontWeight: 600, margin: '0 0 4px' } }, '技能'),
    React.createElement('div', { style: hintStyle() },
      '在 prompt 中输入 ',
      React.createElement('code', { style: { background: 'var(--dsw-alias-bg-layer-2,#f6f6f7)', padding: '1px 5px', borderRadius: 4, fontSize: 11 } }, '@skill:<名称>'),
      ' 即可在会话中引用该技能（平台会在该轮把技能正文注入到模型上下文）。点「复制」即把引用串写入剪贴板。',
      React.createElement('br', null),
      '当前清单：shared 全模式通用 + preset 模式专属。'),
    React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12 } },
      React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#6e6e73)' } }, '只看当前模式专属：'),
      React.createElement('button', { type: 'button', onClick: function () { setPresetId(''); }, style: { padding: '4px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: presetId === '' ? '#dbeafe' : 'transparent', cursor: 'pointer' } }, '全部'),
      React.createElement('button', { type: 'button', onClick: function () { setPresetId('pentest'); }, style: { padding: '4px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: presetId === 'pentest' ? '#dbeafe' : 'transparent', cursor: 'pointer' } }, 'pentest'),
      React.createElement('button', { type: 'button', onClick: function () { setPresetId('code-audit'); }, style: { padding: '4px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: presetId === 'code-audit' ? '#dbeafe' : 'transparent', cursor: 'pointer' } }, 'code-audit')),
    state.status === 'loading' ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#6e6e73)' } }, '加载中…') : null,
    state.status === 'error' ? React.createElement('div', { style: msgStyle(false) }, '无法读取技能清单。') : null,
    state.status === 'ready' && state.skills.length === 0 ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#6e6e73)' } }, presetId ? '当前模式暂未带专属技能（仅 shared）。' : '暂无可用技能。') : null,
    state.skills.map(function (s) { return React.createElement(SkillRow, { key: s.name, skill: s }); }),
    React.createElement('hr', { style: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', margin: '16px 0' } }),
    React.createElement(InstallButton, { connection: props.connection }));

  // 抑制 lint（保留 groupStyle/groupTitleStyle 备扩展用）
  void groupStyle; void groupTitleStyle; void fieldStyle;
}

function apply(ctx) {
  ctx.slots.inject('settings.section', function () {
    return ctx.slots.register({
      name: 'settings.section',
      id: 'skill-browse',
      order: 140,
      label: function () { return '技能'; },
    }, function () {
      return React.createElement(Page, { connection: ctx.connection });
    });
  });
}

module.exports = { name: 'dsh-skill-browse-client', inject: ['slots', 'connection'], apply: apply };
return module.exports; } });
