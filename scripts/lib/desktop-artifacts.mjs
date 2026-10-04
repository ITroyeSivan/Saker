import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

// These are durable installation artifacts: profile file: dependencies refer to them.
// Keep previous revisions so official rollback/reinstall can still resolve old packages.
export function preserveDesktopArtifact(artifact, outputDirectory) {
  const bytes = readFileSync(artifact)
  const digest = value => createHash('sha256').update(value).digest('hex')
  const hash = digest(bytes)
  const destination = join(outputDirectory, `${basename(artifact, '.tgz')}-${hash}.tgz`)
  mkdirSync(outputDirectory, { recursive: true })
  if (existsSync(destination)) {
    if (digest(readFileSync(destination)) !== hash) throw new Error(`Immutable Desktop artifact was modified: ${destination}`)
  } else writeFileSync(destination, bytes, { flag: 'wx' })
  return destination
}
