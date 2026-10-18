// 资料索引的目录引用防越界（v6 第 9.3 节）：用户给的 path 必须留在会话工作目录内，
// 连**符号链接指向目录外**也要挡住（所以实现里对文件和根都做了 realpath）。
import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { indexBusinessMaterials, businessMaterialView } from '../plugins/dsh-redteam-results/lib/business-materials.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-path-guard-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

const site = 'https://app.example.test';
const workspace = path.join(home, 'workspace');
const outside = path.join(home, 'outside');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(workspace, 'app.js'), 'const routes = ["/api/orders"];\n');
fs.writeFileSync(path.join(outside, 'secret.js'), 'const secret = "outside-workspace";\n');

try {
  startTaskPolicy(store, 'sid', { mode: 'regular', target: site, budget: { toolCalls: 5 } });
  saveTaskContext(store, 'sid', { assets: [{ id: 'a', url: site, inScope: true, reachable: true }], requests: [], checks: [] });
  const index = (filePath, url = site + '/static/app.js') => indexBusinessMaterials(store, 'sid', workspace, { site, files: [{ path: filePath, url }] });

  test('工作目录内的文件可以索引', () => {
    const result = index('app.js');
    assert.equal(result.indexed, 1);
    assert.equal(businessMaterialView(store, 'sid').files, 1, '索引后有一条资料');
  });

  test('相对路径越界（../outside）被拒', () => {
    assert.throws(() => index('../outside/secret.js'), /stay inside the session workspace/);
    assert.equal(businessMaterialView(store, 'sid').files, 1, '越界失败不留记录');
  });

  test('绝对路径指向目录外被拒', () => {
    assert.throws(() => index(path.join(outside, 'secret.js')), /stay inside the session workspace/);
  });

  test('file:// 形式的目录外路径同样被拒', () => {
    const url = new URL('file:///' + path.join(outside, 'secret.js').replace(/\\/g, '/')).href;
    assert.throws(() => index(url), /stay inside the session workspace/);
  });

  test('工作目录内指向目录外的符号链接也被挡住（realpath）', () => {
    const link = path.join(workspace, 'link.js');
    try { fs.symlinkSync(path.join(outside, 'secret.js'), link, 'file'); }
    catch (error) {
      // Windows 未开开发者模式时普通用户建不了符号链接：跳过而不是假装通过。
      console.log('     跳过（本机不允许创建符号链接：' + error.code + '）');
      return;
    }
    assert.throws(() => index('link.js'), /stay inside the session workspace/);
    assert.equal(businessMaterialView(store, 'sid').files, 1);
  });

  test('超出 512KB 的单文件被拒（要求分段而不是整文件灌进上下文）', () => {
    fs.writeFileSync(path.join(workspace, 'big.js'), 'x'.repeat(512 * 1024 + 1));
    assert.throws(() => index('big.js', site + '/static/big.js'), /at most 512KB/);
  });
} finally { store.close(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); }
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
