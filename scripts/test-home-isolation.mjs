// Every test process owns an application-data home. Never inherit live user
// stores, even when the caller has DSH_HOME set for their running application.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.SAKER_TEST_HOME_PROCESS !== String(process.pid)) {
  const home = mkdtempSync(join(tmpdir(), 'saker-test-home-'))
  process.env.DSH_HOME = home
  process.env.DSH_ATLAS_DB = join(home, 'attack-atlas', 'atlas.db')
  process.env.SAKER_TEST_HOME_PROCESS = String(process.pid)
  // Windows 上子进程（如知识库索引）刚退出时句柄可能还没释放，第一次删除会 EPERM。
  // 这里同步小睡后重试几次；'exit' 阶段不能再设 exitCode（已经无效），所以失败必须**打印出来**，
  // 剩下的交给 run-all-tests.mjs 的收尾清扫。
  process.on('exit', () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { rmSync(home, { recursive: true, force: true }); return }
      catch (error) {
        if (attempt === 4) { console.error('test home cleanup failed: ' + home + ': ' + error.message); return }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
      }
    }
  })
}
