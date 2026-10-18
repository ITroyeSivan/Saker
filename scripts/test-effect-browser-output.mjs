// 输出处理类别的真浏览器复验：把靶场**原样产出的响应字节**交给 headless Chrome 解析，
// 断言有缺陷的页面里载荷真的执行、已加固的页面里不执行。
//
// 为什么单独一套而不是塞进 test-task-effect-benchmark.mjs：
//   ① `revcheck-effect-qualification.mjs` 会把那个文件复制到临时目录里跑 5 遍，
//      浏览器启动会被放大成 5×2 次；
//   ② 复制后的相对路径会解析到不存在的临时根（`_ref/_ref/tmp`），
//      在错误路径上抛错还会把靶场的 HTTP 服务留在事件循环里不退出 —— 2026-10-11 实测过一次挂死。
//
// 为什么用 file:// 而不是直接开靶场 URL：本机 Chrome 加载 `http://127.0.0.1:<port>`
// 会一直挂住（`--headless` / `--headless=new` / `--headless=old`、加不加 `--dump-dom`
// 四种组合实测都 20s 超时且没有任何输出），而 `data:` 与 `file:` 都正常。写到磁盘的仍是
// 靶场真实响应字节，不是另写一份 HTML。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createEffectLab } from '../benchmarks/task-effects/lab.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundary = resolve(root, '..', '_ref', 'tmp');
const chromeExecutable = () => [process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(candidate => candidate && existsSync(candidate));

const chrome = chromeExecutable();
if (process.platform !== 'win32' || chrome === undefined) {
  console.log('ok skipped: no Chrome available; browser-observable output was not verified');
  process.exit(0);
}

// 标记由脚本在运行时算出（"SAKER-EXEC-" + (6*7)），所以"DOM 里出现这段源码文字"不等于执行。
const payload = '<script>document.title="SAKER-EXEC-"+(6*7)</script>';
const marker = 'SAKER-EXEC-42';
let failed = 0;

for (const [id, shouldExecute] of [['u1', true], ['u2', false]]) {
  const lab = await createEffectLab(id);
  let profile;
  try {
    profile = mkdtempSync(join(boundary, 'echo-browser-'));
    const receipt = await lab.request(lab.controller.echoRequest('subject', payload));
    assert.equal(receipt.status, 200, `${id}: the lab must answer the browser payload`);
    const page = join(profile, 'echo.html');
    writeFileSync(page, Buffer.from(receipt.responseBodyBase64, 'base64'));
    const dump = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`, `--crash-dumps-dir=${profile}`, '--virtual-time-budget=2000', '--dump-dom',
      pathToFileURL(page).href], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    const dom = `${dump.stdout ?? ''}${dump.stderr ?? ''}`;
    assert(dom.includes('Local Echo'), `${id}: the browser must have loaded the exercise page (status ${dump.status})`);
    assert(dom.includes('SAKER-EXEC-'), `${id}: the payload text must have been reflected`);
    assert.equal(dom.includes(marker), shouldExecute, `${id}: browser-observable execution must be ${shouldExecute}`);
    console.log(`ok ${id}: headless Chrome ${shouldExecute ? 'executed' : 'did not execute'} the reflected payload`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${id}: ${error.message}`);
  } finally {
    // 靶场的 HTTP 服务必须先关：它在错误路径上留着，Node 就永远不退出（实测挂死过一次）。
    await lab.close();
    if (profile !== undefined) {
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      catch (error) { console.log(`   （浏览器 profile 未清掉，留给回归收尾清扫：${error.message}）`); }
    }
  }
}

process.exitCode = failed ? 1 : 0;
