// dsh-skill-browse — web client.
// 设置页「技能」面板：列出当前可引用的技能（shared / preset / user 三层），
// 支持上传 zip/tgz 压缩包安装到用户层、卸载用户层技能、一键复制 `/name`
// 引用串。
//
// 真实调用语义（对齐宿主 tool-skill / ui-skill，本面板不发明新语法）：
//   - 模型自动：会话开始宿主把 <available_skills> 目录发给模型，任务匹配时
//     模型调 `skill` 工具按名加载正文——无需用户操作。
//   - 用户手动：在输入框打 `/` 会弹出技能候选（宿主 ui-skill），选中即插入
//     `/name`；发消息后宿主把该技能正文注入当轮。
//   - 本面板「复制」按钮只产出 `/name`（上版 `@skill:` 语法宿主不识别，已弃）。
window.__ModuleLoader__.load({ id: '@dsh-external/dsh-skill-browse', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict';
/* SAKER-UI-KIT:BEGIN */
var SAKER_UI_KIT_CSS = "/* 5.7 共享组件层：Button / Input / Select / Badge / DataTable / Drawer / InlineNotice / EmptyState\n   单一来源：shared/ui-kit/ui-kit.css（令牌见 shared/ui-kit/ui-kit.json）。\n   由 scripts/sync-ui-kit.mjs 注入到各产品插件；插件里的同类尺寸规则应删除，避免双写。 */\n.saker-ui-btn{height:32px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px}\n.saker-ui-input{height:36px;border-radius:6px}\n.saker-ui-select{height:32px;border-radius:6px}\n.saker-ui-table td{height:38px}\n.saker-ui-badge{border-radius:6px;font-size:12px;line-height:1.5}\n.saker-ui-drawer{border-radius:12px}\n.saker-ui-notice{border-radius:6px;font-size:13px;line-height:1.5}\n.saker-ui-empty{border-radius:6px;font-size:13px;line-height:1.5}\n/* 现有插件类别名：与 canonical 类共用同一套尺寸 */\n.dsh-chat-panel-head button,.dsh-chat-actions button,.dsh-chat-task-status button,.dsh-task-nav button,.dsh-task-actions button{height:32px;display:inline-flex;align-items:center;justify-content:center}\n.dsh-prompt-io button,.dsh-prompt-more,.dsh-prompt-scopes button,.dsh-prompt-modes button,.dsh-prompt-foot button{height:32px;display:inline-flex;align-items:center;justify-content:center}\n.dsh-materials-tools button,.dsh-materials-types button,.dsh-materials-foot button,.dsh-materials-table td button{height:32px;display:inline-flex;align-items:center;justify-content:center}\n.dsh-materials-new button,.dsh-materials-import-actions button,.dsh-execution-tools>button,.dsh-test-content-actions button,.dsh-rtr-btn{height:32px;display:inline-flex;align-items:center;justify-content:center}\n.dsh-task-nav select,.dsh-materials-tools select,.dsh-rtr-select{height:32px}\n.dsh-prompt-saveas input,.dsh-prompt-list input[type=search],.dsh-prompt-field input{height:36px}\n.dsh-materials-tools input[type=search],.dsh-materials-import input,.dsh-task-field input,.dsh-rtr-search{height:36px}\n.dsh-materials-table td{height:38px}\n.dsh-chat-setup svg,.dsh-task-workspace svg{width:16px;height:16px}\n.dsh-hnt-btn,.dsh-hnt-tab{height:32px}\n.dsh-hnt-input{height:36px}\n.dsh-hnt-select{height:32px}\n.dsh-mcs-btn,.dsh-mcs-iconbtn,.dsh-mcs-toolscount--btn{height:32px}\n.dsh-mcs-field input,.dsh-mcs-pairrow input,.dsh-mcs-search{height:36px}\n.dsh-mcs-field select,.dsh-mcs-seg button{height:32px}\n.dsh-sp-chip.is-btn{height:32px}\n.dsh-mg-chip{height:32px}\n/* 内联 style 插件（sec-config / skill-browse）：根容器打 data-saker-ui，\n   控件尺寸由共享层统一给，插件自己的 helper 不再写 height。 */\n[data-saker-ui] button{height:32px}\n[data-saker-ui] input:not([type=checkbox]):not([type=radio]):not([type=file]){height:36px}";
/* SAKER-UI-KIT:END */
(function(){try{if(document.getElementById('saker-ui-kit-style'))return;var st=document.createElement('style');st.id='saker-ui-kit-style';st.textContent=SAKER_UI_KIT_CSS;document.head.appendChild(st);}catch(e){}})();
var React = require('react');
var useState = React.useState, useEffect = React.useEffect;

var CHANNEL = '/dsh-skill-browse';

function rpc(connection, endpoint, payload) {
  return connection.rpc.call(CHANNEL, endpoint, payload);
}

function hintStyle() { return { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #6e6e73)', marginBottom: 8, lineHeight:1.5}; }
function msgStyle(ok) { return { marginTop: 8, fontSize: 12, color: ok ? '#1a7f37' : '#d1242f' }; }
function btnStyle(primary) { return { padding: '7px 14px', borderRadius: 6, border: '1px solid ' + (primary ? 'transparent' : 'var(--dsw-alias-border-l1,#d9d9de)'), background: primary ? 'var(--dsw-alias-state-business-primary,#4c6ef5)' : 'transparent', color: primary ? '#fff' : 'var(--dsw-alias-label-primary,#1a1a1a)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }; }
function originBadge(origin) {
  if (origin === 'user') return { label: '已安装', bg: '#dafbe1', fg: '#1a7f37' };
  if (origin === 'preset') return { label: '模式专属', bg: '#fef3c7', fg: '#92400e' };
  return { label: '共享', bg: '#e0f2fe', fg: '#075985' };
}

function CopyButton(props) {
  var [state, setState] = useState('idle');
  function copy() {
    var text = '/' + props.name + ' ';
    var done = function () { setState('copied'); setTimeout(function () { setState('idle'); }, 1600); };
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
  var label = state === 'copied' ? '已复制' : (state === 'failed' ? '复制失败' : '复制 /' + props.name);
  return React.createElement('button', {
    type: 'button', title: '复制到剪贴板；在会话输入框粘贴后按 /name 注入该技能正文',
    onClick: copy,
    style: { padding: '4px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsw-alias-state-business-primary,#4c6ef5)', background: state === 'copied' ? '#dafbe1' : 'transparent', color: state === 'copied' ? '#1a7f37' : 'var(--dsw-alias-state-business-primary,#4c6ef5)', cursor: 'pointer', flex: '0 0 auto' },
  }, label);
}

function SkillRow(props) {
  var skill = props.skill;
  var badge = originBadge(skill.origin);
  return React.createElement('div', { style: { padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l1,#e4e4e7)', borderRadius: 8, marginBottom: 8, background: 'var(--dsw-alias-bg-base,#fff)' } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
      React.createElement('span', { style: { fontWeight: 600, fontSize: 13, fontFamily: 'ui-monospace, Consolas, monospace' } }, '/' + skill.name),
      React.createElement('span', { style: { fontSize: 12, padding: '1px 6px', borderRadius: 999, background: badge.bg, color: badge.fg, fontWeight: 600 } }, badge.label),
      React.createElement('div', { style: { flex: 1 } }),
      skill.origin === 'user' ? (props.confirming
        ? React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, flex: '0 0 auto' } },
          '卸载 /' + skill.name + ' ？',
          React.createElement('button', {
            type: 'button', onClick: props.onRemove,
            style: { padding: '4px 10px', fontSize: 12, borderRadius: 6, border: '1px solid #d1242f', background: '#fff5f5', color: '#d1242f', cursor: 'pointer', fontWeight: 700 },
          }, '卸载'),
          React.createElement('button', {
            type: 'button', onClick: props.onCancel,
            style: { padding: '4px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: 'transparent', color: 'var(--dsw-alias-label-primary,#1a1a1a)', cursor: 'pointer' },
          }, '取消'))
        : React.createElement('button', {
          type: 'button', title: '卸载该用户层技能',
          onClick: props.onRequest,
          style: { padding: '4px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: 'transparent', color: '#d1242f', cursor: 'pointer', flex: '0 0 auto' },
        }, '卸载')) : null,
      React.createElement(CopyButton, { name: skill.name })),
    skill.description ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary,#4a4a4f)', lineHeight:1.5} }, skill.description) : null);
}

// ── 上传安装（zip / tgz / tar.gz）──────────────────────────────────────────
function UploadBox(props) {
  var fileRef = React.useRef(null);
  var [busy, setBusy] = useState(false);
  var [msg, setMsg] = useState(null);
  var [fileName, setFileName] = useState('');

  function pick(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    setFileName(file.name);
    setBusy(true); setMsg(null);
    var reader = new FileReader();
    reader.onload = function () {
      var data = String(reader.result).split(',')[1] || '';
      rpc(props.connection, 'install-archive', { fileName: file.name, dataBase64: data }).then(function (res) {
        setBusy(false);
        if (res && res.ok && res.value && res.value.installed) {
          var name = res.value.installed.name;
          setMsg({ ok: true, text: '已安装 /' + name + ' —— 输入框打 / 或直接粘贴即可引用。' });
          props.onInstalled && props.onInstalled();
        } else {
          setMsg({ ok: false, text: '安装失败：' + ((res && res.error && res.error.message) || '未知错误') });
        }
      }).catch(function (e) { setBusy(false); setMsg({ ok: false, text: String(e && e.message || e) }); });
    };
    reader.onerror = function () { setBusy(false); setMsg({ ok: false, text: '读取文件失败' }); };
    reader.readAsDataURL(file);
    ev.target.value = '';
  }

  return React.createElement('div', { style: { border: '1px dashed var(--dsw-alias-border-l2,#c9c9d0)', borderRadius: 8, padding: '12px', marginBottom: 12, background: 'var(--dsw-alias-bg-layer-2,#fafafb)' } },
    React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, '上传技能压缩包'),
    React.createElement('div', { style: hintStyle() },
      '选择本机的 .zip / .tgz / .tar.gz（内应含一个技能目录，如 my-skill/SKILL.md，或一个顶层 my-skill.md；SKILL.md 需带 name 与 description frontmatter）。安装到平台技能目录 skills/<name>/（即 $DSH_HOME 或 ~/.dsh 之下），宿主热载，无需重启——上传后当前会话的输入框打 / 即可看到。'),
    React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      React.createElement('input', {
        ref: fileRef, type: 'file', accept: '.zip,.tgz,.tar.gz',
        style: { display: 'none' },
        onChange: pick,
      }),
      React.createElement('button', { type: 'button', disabled: busy, style: btnStyle(false), onClick: function () { fileRef.current && fileRef.current.click(); } }, busy ? '安装中…' : (fileName ? '重选：' + fileName : '选择压缩包…')),
      msg ? React.createElement('span', { style: msgStyle(msg.ok) }, msg.text) : null));
}

function Page(props) {
  var [state, setState] = useState({ status: 'loading', skills: [] });
  var [presetId, setPresetId] = useState('');
  var [reloadTick, setReloadTick] = useState(0);
  var [msg, setMsg] = useState(null);
  // 卸载的行内两段式确认（原生 confirm 会阻塞渲染进程，Agent 驱动的整页卡死）
  var [confirmName, setConfirmName] = useState('');

  function load() {
    setState({ status: 'loading', skills: [] });
    rpc(props.connection, 'list', { presetId: presetId }).then(function (res) {
      if (res && res.ok && res.value && Array.isArray(res.value.skills)) {
        setState({ status: 'ready', skills: res.value.skills });
      } else {
        setState({ status: 'error', skills: [] });
      }
    }).catch(function () { setState({ status: 'error', skills: [] }); });
  }
  useEffect(load, [presetId, reloadTick]);

  function requestRemove(name) { setConfirmName(name); }
  function cancelRemove() { setConfirmName(''); }
  function remove(name) {
    rpc(props.connection, 'remove-skill', { name: name }).then(function (res) {
      if (res && res.ok) {
        setReloadTick(function (t) { return t + 1; });
        // 服务端是「移进同层 .trash/」而不是直接删 —— 告诉用户还能找回
        var trashed = res.value && res.value.trash;
        setMsg({ ok: true, text: trashed ? '已卸载（移入技能目录 .trash/，可人工找回）' : '已卸载' });
      }
      else setMsg({ ok: false, text: ((res && res.error && res.error.message) || '卸载失败') });
    }).catch(function (e) { setMsg({ ok: false, text: String(e && e.message || e) }); });
  }

  return React.createElement('div', { style: { maxWidth: 640 }, 'data-saker-ui': 'skill-browse' },
    React.createElement('div', { style: { fontSize: 13, fontWeight: 600, margin: '0 0 4px' } }, '技能'),
    React.createElement('div', { style: hintStyle() },
      '选择一份操作指南供 AI 使用。在聊天中输入 ',
      React.createElement('code', { style: { background: 'var(--dsw-alias-bg-layer-2,#f6f6f7)', padding: '1px 5px', borderRadius: 4, fontSize: 12 } }, '/技能名'),
      ' 即可调用，也可以上传自己的技能包。'),
    React.createElement(UploadBox, { connection: props.connection, onInstalled: function () { setReloadTick(function (t) { return t + 1; }); } }),
    React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 } },
      React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#6e6e73)' } }, '范围筛选：'),
      React.createElement('button', { type: 'button', onClick: function () { setPresetId(''); }, style: { padding: '4px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: presetId === '' ? '#dbeafe' : 'transparent', cursor: 'pointer' } }, '全部'),
      React.createElement('button', { type: 'button', onClick: function () { setPresetId('pentest'); }, style: { padding: '4px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: presetId === 'pentest' ? '#dbeafe' : 'transparent', cursor: 'pointer' } }, '渗透测试'),
      React.createElement('button', { type: 'button', onClick: function () { setPresetId('code-audit'); }, style: { padding: '4px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: presetId === 'code-audit' ? '#dbeafe' : 'transparent', cursor: 'pointer' } }, '代码审计'),
      React.createElement('button', { type: 'button', onClick: function () { setPresetId('ctf-solver'); }, style: { padding: '4px 10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1,#d9d9de)', background: presetId === 'ctf-solver' ? '#dbeafe' : 'transparent', cursor: 'pointer' } }, 'CTF')),
    msg ? React.createElement('div', { style: { marginBottom: 8 } }, React.createElement('span', { style: msgStyle(msg.ok) }, msg.text)) : null,
    state.status === 'loading' ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#6e6e73)' } }, '加载中…') : null,
    state.status === 'error' ? React.createElement('div', { style: msgStyle(false) }, '无法读取技能清单。') : null,
    state.status === 'ready' && state.skills.length === 0 ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary,#6e6e73)' } }, '当前筛选下没有技能。') : null,
    state.skills.map(function (s) { return React.createElement(SkillRow, { key: s.name, skill: s, confirming: confirmName === s.name, onRequest: function () { requestRemove(s.name); }, onCancel: cancelRemove, onRemove: function () { setConfirmName(''); remove(s.name); } }); }));
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
