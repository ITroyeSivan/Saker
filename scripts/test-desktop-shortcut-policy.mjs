import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { dailyDesktopHome, shouldRefreshDailyShortcut } from './lib/desktop-shortcut-policy.mjs';

let failed = 0;
function test(label, fn) { try { fn(); console.log('ok ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }

const daily = join(homedir(), '.dsh');

await test('installing into the daily home refreshes the daily shortcut', () => {
  const result = shouldRefreshDailyShortcut({ home: daily, dailyHome: daily });
  assert.equal(result.sameHome, true);
  assert.equal(result.refresh, true);
});

await test('installing into an isolated home must not repoint the daily shortcut', () => {
  const isolated = join(homedir(), '.dsh-iso', 'run-1', 'home');
  const result = shouldRefreshDailyShortcut({ home: isolated, dailyHome: daily });
  assert.equal(result.sameHome, false);
  assert.equal(result.refresh, false, 'an isolated install must leave the daily entry alone');
});

await test('a workspace temp home is refused even when it looks like a DSH home', () => {
  const temp = 'E:\\工作\\WorkBuddy\\WebSec\\dsh\\_ref\\tmp\\saker-effect-iso-1\\home';
  assert.equal(shouldRefreshDailyShortcut({ home: temp, dailyHome: daily }).refresh, false);
});

await test('only an explicit override may repoint the daily shortcut', () => {
  const isolated = join(homedir(), '.dsh-iso', 'home');
  assert.equal(shouldRefreshDailyShortcut({ home: isolated, dailyHome: daily, override: true }).refresh, true);
  assert.equal(shouldRefreshDailyShortcut({ home: isolated, dailyHome: daily, override: 'yes' }).refresh, false,
    'only boolean true counts as an override');
});

await test('separator and case differences still count as the daily home', () => {
  assert.equal(shouldRefreshDailyShortcut({ home: daily + sep, dailyHome: daily }).refresh, true);
  if (process.platform === 'win32') {
    assert.equal(shouldRefreshDailyShortcut({ home: daily.toUpperCase(), dailyHome: daily }).refresh, true);
  }
});

await test('a missing home is a hard error, not a silent refresh', () => {
  assert.throws(() => shouldRefreshDailyShortcut({ home: '' }), /home is required/);
  assert.throws(() => shouldRefreshDailyShortcut({}), /home is required/);
  assert.equal(typeof dailyDesktopHome(), 'string');
});

console.log('Fixture verification only: no Desktop installation or shortcut is touched.');
process.exitCode = failed ? 1 : 0;
