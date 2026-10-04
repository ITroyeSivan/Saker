import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { preserveDesktopArtifact } from './lib/desktop-artifacts.mjs'

const fixture = mkdtempSync(join(tmpdir(), 'saker-desktop-boundary-'))
let assertion = 'desktop installer refuses before profile writes or CLI invocation'
try {
  const profile = join(fixture, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  const pkg = join(profile, 'package.json')
  const original = JSON.stringify({ dependencies: { 'dsh-saker': 'file:missing.tgz' }, dsh: { profile: { bundles: ['dsh-saker'] } } })
  writeFileSync(pkg, original)
  const invoked = join(fixture, 'cli-invoked')
  const cli = join(fixture, 'cli.mjs')
  writeFileSync(cli, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.TEST_CLI_MARKER, 'called'); process.exit(1);\n")
  const installer = fileURLToPath(new URL('./install-all.mjs', import.meta.url))
  for (const name of ['desktop', 'DESKTOP', ' desktop ']) {
    const result = spawnSync(process.execPath, [installer, '--force'], { encoding: 'utf8',
      env: { ...process.env, DSH_HOME: fixture, SAKER_PROFILE: name, SAKER_RETRIES: '1',
        TEST_CLI_MARKER: invoked, DSH_CLI: `"${process.execPath}" "${cli}"` }, timeout: 15000 })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stderr, /Desktop profile is managed/)
    assert.equal(readFileSync(pkg, 'utf8'), original, 'desktop profile was reconciled before refusal')
    assert.equal(existsSync(invoked), false, 'external CLI was invoked')
    console.log(`ok   desktop installer refuses before profile writes or CLI invocation: ${JSON.stringify(name)}`)
  }
  assertion = 'retired Web installer performs no package operations'
  for (const name of ['', 'web', ' WEB ']) {
    const result = spawnSync(process.execPath, [installer], { encoding: 'utf8',
      env: { ...process.env, DSH_HOME: fixture, SAKER_PROFILE: name,
        TEST_CLI_MARKER: invoked, DSH_CLI: `"${process.execPath}" "${cli}"` }, timeout: 15000 })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stderr, /standalone Web deployment is retired/)
    assert.equal(readFileSync(pkg, 'utf8'), original)
    assert.equal(existsSync(invoked), false)
    console.log(`ok   retired Web installer performs no package operations: ${JSON.stringify(name)}`)
  }
  assertion = 'same-version Desktop tarball revisions preserve distinct immutable dependencies'
  const mutable = join(fixture, 'same-1.0.0.tgz')
  const output = join(fixture, 'delivery')
  writeFileSync(mutable, 'first package bytes')
  const first = preserveDesktopArtifact(mutable, output)
  assert.equal(preserveDesktopArtifact(mutable, output), first)
  writeFileSync(mutable, 'second package bytes')
  const second = preserveDesktopArtifact(mutable, output)
  assert.notEqual(second, first)
  assert.equal(readFileSync(first, 'utf8'), 'first package bytes')
  assert.equal(readFileSync(second, 'utf8'), 'second package bytes')
  console.log('ok   ' + assertion)
  assertion = 'modified immutable Desktop artifacts are rejected'
  writeFileSync(second, 'tampered')
  assert.throws(() => preserveDesktopArtifact(mutable, output), /Immutable Desktop artifact was modified/)
  console.log('ok   ' + assertion)
} catch (error) {
  console.log('FAIL ' + assertion + ': ' + error.message)
  process.exitCode = 1
} finally { rmSync(fixture, { recursive: true, force: true }) }
