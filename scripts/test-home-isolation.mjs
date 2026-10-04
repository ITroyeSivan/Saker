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
  process.on('exit', () => {
    try { rmSync(home, { recursive: true, force: true }) }
    catch (error) { console.error('test home cleanup failed: ' + home + ': ' + error.message); process.exitCode = 1 }
  })
}
