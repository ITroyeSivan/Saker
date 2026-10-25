// 输出处理类别的真浏览器复验：把靶场**原样产出的响应字节**交给 Chrome for Testing 解析，
// 断言有缺陷的页面里载荷真的执行、已加固的页面里不执行。
//
// 为什么单独一套而不是塞进 test-task-effect-benchmark.mjs：
//   ① `revcheck-effect-qualification.mjs` 会把那个文件复制到临时目录里跑 5 遍，
//      浏览器启动会被放大成 5×2 次；
//   ② 复制后的相对路径会解析到不存在的临时根（`_ref/_ref/tmp`），
//      在错误路径上抛错还会把靶场的 HTTP 服务留在事件循环里不退出 —— 2026-10-11 实测过一次挂死。
//
// 旧版用 `--dump-dom` + file://。Chrome for Testing 在这台机器上会超时，普通 Chrome
// 又不允许用于验收；因此改为本地 HTTP 原样回放靶场字节，再由 CfT 的 CDP 页面执行探针读取结果。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { createEffectLab } from '../benchmarks/task-effects/lab.mjs';
import { runBrowserExecution } from '../plugins/dsh-redteam-results/lib/browser-execution.js';

const chromeExecutable = () => [process.env.SAKER_CFT_PATH,
  'E:/software/ChromeForTesting/chrome-win64/chrome.exe'].find(candidate => candidate && existsSync(candidate));

const chrome = chromeExecutable();
if (chrome === undefined) {
  console.log('ok skipped: Chrome for Testing is unavailable; browser-observable output was not verified');
  process.exit(0);
}

// 标记由脚本在运行时算出（"SAKER-EXEC-" + (6*7)），所以"DOM 里出现这段源码文字"不等于执行。
const payload = '<script>window.__sakerProbe="SAKER-EXEC-"+(6*7)</script>';
const marker = 'SAKER-EXEC-42';
let failed = 0;

for (const [id, shouldExecute] of [['u1', true], ['u2', false]]) {
  const lab = await createEffectLab(id);
  let server;
  try {
    const receipt = await lab.request(lab.controller.echoRequest('subject', payload));
    assert.equal(receipt.status, 200, `${id}: the lab must answer the browser payload`);
    const body = Buffer.from(receipt.responseBodyBase64, 'base64');
    let served = 0;
    server = http.createServer((_request, response) => {
      served += 1;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(body);
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const result = await runBrowserExecution({
      url: origin + '/echo.html', marker, executablePath: chrome, timeoutMs: 30000,
    });
    assert(served >= 1, `${id}: the browser must request the exercised page`);
    assert.equal(result.origin, origin);
    assert.equal(result.executed, shouldExecute, `${id}: browser-observable execution must be ${shouldExecute}`);
    assert.equal(result.probeValue, shouldExecute ? marker : null);
    console.log(`ok ${id}: Chrome for Testing ${shouldExecute ? 'executed' : 'did not execute'} the reflected payload`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${id}: ${error.message}`);
  } finally {
    if (server !== undefined) await new Promise(done => server.close(done));
    await lab.close();
  }
}

process.exitCode = failed ? 1 : 0;
