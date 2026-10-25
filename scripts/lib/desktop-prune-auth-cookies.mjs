import fs from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const MATCH_SQL = "host_key='127.0.0.1' AND name LIKE 'dsh-auth-%'"

export function pruneDesktopAuthCookies(database) {
  if (!fs.existsSync(database)) return { removed: 0, skipped: true }

  const db = new DatabaseSync(database)
  try {
    db.exec('BEGIN IMMEDIATE')
    const before = Number(db.prepare(`SELECT count(*) AS n FROM cookies WHERE ${MATCH_SQL}`).get().n)
    if (before) db.prepare(`DELETE FROM cookies WHERE ${MATCH_SQL}`).run()
    db.exec('COMMIT')
    return { removed: before, skipped: false }
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  } finally {
    db.close()
  }
}

const invokedAsScript = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedAsScript) {
  const database = process.argv[2]
  if (!database) throw new Error('usage: node desktop-prune-auth-cookies.mjs <Cookies.sqlite>')
  const result = pruneDesktopAuthCookies(database)
  if (result.skipped) console.log('desktop-auth-cookie-prune: database missing, skipped')
  else console.log(`desktop-auth-cookie-prune: removed ${result.removed} loopback launch cookie(s)`)
}
