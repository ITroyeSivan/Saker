import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const template = process.env.SAKER_LAUNCHER_TEMPLATE ?? join(root, 'scripts', 'lib', 'desktop-launch.ps1');
const deployed = process.env.SAKER_LAUNCHER_DEPLOYED ?? resolve(root, '..', '_ref', 'tools', 'Start-SakerDesktop.ps1');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

let failed = 0;
function test(label, fn) { try { fn(); console.log('ok ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }

const source = readFileSync(template, 'utf8');

await test('the launcher refuses a second instance and says why', () => {
  // 0.2.1 起宿主用随机端口（V06/A02），固定 19387 的冲突理由不再成立；
  // 但同一个日常 userData 起第二个实例仍会互相抢会话/存储，启动器必须先拦下来说清原因。
  assert.match(source, /Where-Object \{ \$_.ExecutablePath -eq \$executable \}/,
    'ownership must be decided by the executable path, not by process name');
  assert.match(source, /This daily configuration cannot start twice/, 'refusal must state the real reason (same daily configuration)');
  assert.doesNotMatch(source, /fixed port 127\.0\.0\.1:19387/, '0.2.1 no longer uses a fixed port; the launcher must not claim one');
  assert.match(source, /if \(\$daily\.Count -gt 0\)/);
});

await test('the launcher focuses the existing window instead of doing nothing', () => {
  // 快捷方式是 -WindowStyle Hidden 运行的：只打印消息用户看不见，
  // 必须把已有窗口激活到前台，否则双击"像没反应"。
  assert.match(source, /AppActivate/);
  assert.match(source, /Where-Object \{ \$idList -notcontains \$_.ParentProcessId \}/,
    'the window belongs to the root process, not to an arbitrary child');
});

await test('the launcher never focuses a verification instance as the daily window', () => {
  // 隔离验收实例跑的是同一个 exe，但 --user-data-dir 指向临时目录、DSH_HOME 也是临时目录，
  // 所以它的会话列表是空的。它长得和日常 App 一模一样：把它聚焦到前台，用户会以为
  // "我的会话全没了"。只有带本启动器 userDataDirectory 的实例才算日常窗口。
  assert.match(source, /\$daily = @\(\$running \| Where-Object \{ \$_.CommandLine -and \$_.CommandLine\.Contains\(\$dailyUserData\) \}\)/,
    'the daily window must be selected by the launcher-owned userData directory');
  assert.match(source, /\$foreign = @\(\$running \| Where-Object \{ \$daily -notcontains \$_ \}\)/);
  assert.match(source, /if \(\$foreign\.Count -gt 0\)/);
  const foreign = source.slice(source.indexOf('if ($foreign.Count -gt 0)'));
  assert.doesNotMatch(foreign, /AppActivate/,
    'a foreign instance must never be activated');
  assert.match(foreign, /System\.Windows\.Forms\.MessageBox/,
    'the shortcut runs hidden, so the refusal must be visible in a dialog');
});

await test('the launcher prunes only loopback launch cookies with an explicit Node runtime', () => {
  assert.match(source, /\$settings\.nodeExecutable/,
    'the launcher must use the Node path captured when the shortcut is refreshed');
  assert.match(source, /prune-desktop-auth-cookies\.mjs/,
    'the launcher must invoke the deployed cookie pruner');
  assert.match(source, /& \(\[string\]\$settings\.nodeExecutable\) \$cookieHelper \$cookieDb/,
    'the helper must run with an explicit executable and database argument');
  assert.doesNotMatch(source, /&\s+node\s+/, 'the launcher must not depend on node from PATH');
});

await test('the launcher restores the Electron window started by a hidden shortcut', () => {
  assert.match(source, /Start-Process .* -PassThru/,
    'the launcher must track the process that owns the new window');
  assert.match(source, /ShowWindowAsync\(window, 9\)/,
    'the launcher must restore the hidden Electron window');
  assert.match(source, /SetForegroundWindow\(window\)/,
    'the restored window must be brought to the foreground');
  assert.match(source, /Chrome_WidgetWin_1/,
    'window selection must target the Electron main window, not the hidden message window');
});

await test('the deployed launcher matches the repo template', () => {
  if (!existsSync(deployed)) { console.log('   （未部署副本，跳过一致性比对）'); return }
  assert.equal(hash(deployed), hash(template),
    'the shortcut runs _ref/tools/Start-SakerDesktop.ps1; it must not drift from scripts/lib/desktop-launch.ps1');
});

console.log('Fixture verification only: no Desktop process is started or stopped.');
process.exitCode = failed ? 1 : 0;
