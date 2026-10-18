// Desktop 进程归属门禁：0.2.1 随机端口后，启动/回退不能再依赖 19387。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { desktopProcesses } from './lib/desktop-process.mjs';

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const restore = read('./restore-desktop.mjs');
const launcher = read('./lib/desktop-launch.ps1');
const redteamClient = read('../plugins/dsh-redteam-results/lib/client.js');
const hasFixedPort = text => /19387/.test(text);

assert.equal(hasFixedPort(restore), false, '回退判断不能继续依赖固定端口 19387');
assert.equal(hasFixedPort(launcher), false, '启动器不能继续依赖固定端口 19387');
assert.equal(hasFixedPort('127.0.0.1:19387'), true, '反向：旧固定端口写法必须被门禁识别');
console.log('ok   desktop startup/restore no longer assumes fixed port 19387');

const all = desktopProcesses({});
assert.ok(Array.isArray(all), '进程归属探测必须返回数组，不能默认已退出');
const foreign = desktopProcesses({ executable: 'E:/definitely/not/a/real/DeepSeek Harness.exe', userDataDirectory: 'E:/definitely/not/a/real/user-data' });
assert.deepEqual(foreign, [], '不匹配的路径不能误认成日常 Desktop');
console.log('ok   desktop process ownership filters by executable and userData');

assert.match(redteamClient, /\/api\/dsh-redteam-results/, '0.2.1 的 /api 前缀必须被客户端探测');
assert.match(redteamClient, /\/dsh-redteam-results/, '0.2.0 的旧根路径必须保留为回退');
assert.match(redteamClient, /detectApiBase/, '客户端必须集中解析 base，而不是每个调用点写死');
console.log('ok   redteam client resolves both 0.2.0 and 0.2.1 API bases');
