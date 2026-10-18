import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { createPresetVisibility } from './preset-visibility.mjs'
import { patchAgentPresets } from './preset-roster-patch.mjs'

export const inject = ['agentPresets']

/**
 * Register the bundle-owned read-only preset root after the agentPresets
 * service exists. The presets stay inside the installed package — no copy is
 * made into the user's DSH_HOME, so updating the bundle swaps the modes
 * atomically and uninstalling removes them without residue.
 *
 * dsh 0.1.6 owns presets through `agentPresets.resolvedRoots`; dsh 0.1.7
 * replaced that with `agentPresets.register()` and ordinary declarative rows.
 * This plugin supports both so one package can boot either host.
 */
// Keep an already-selected CTF preset resolvable for old sessions while hiding it
// from new-session lists unless the user explicitly opts in.
const presetVisibility = createPresetVisibility()
const DEFAULT_PRESET = 'pentest'
const DECLARATIVE_PRESETS = ['pentest', 'code-audit', 'ctf-solver']

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
})
const patchSchema = yaml.JSON_SCHEMA.extend(JsExpr)

function filterPreset(p) {
  return presetVisibility.isVisible(p)
}

function evaluateExpression(expression, baseUrl, ctx) {
  return Function('baseUrl', 'ctx', `with (ctx) { return (${expression}) }`)(baseUrl, ctx)
}

function materialize(value, baseUrl, ctx) {
  if (Array.isArray(value)) return value.map((item) => materialize(item, baseUrl, ctx))
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 1 && typeof value.__jsExpr === 'string') {
      return evaluateExpression(value.__jsExpr, baseUrl, ctx)
    }
    const out = {}
    for (const key of keys) out[key] = materialize(value[key], baseUrl, ctx)
    return out
  }
  return value
}

function loadPresetConfig(id, ctx) {
  const patchUrl = new URL(`../preset/${id}/agent.patch.yml`, import.meta.url)
  const parsed = yaml.load(readFileSync(fileURLToPath(patchUrl), 'utf8'), { schema: patchSchema })
  const config = parsed?.[0]?.insert?.[0]?.config
  if (!config || typeof config !== 'object') {
    throw new Error(`dsh-saker: preset ${id} has no declarative config in ${fileURLToPath(patchUrl)}`)
  }
  return materialize(config, new URL(`../preset/${id}/`, import.meta.url).href, ctx)
}

export async function apply(ctx) {
  const presets = ctx.get('agentPresets')
  if (!presets) return

  // dsh 0.1.6: mount the bundle-owned directory as a read-only preset root.
  if (typeof presets.resolvedRoots !== 'undefined') {
    const root = fileURLToPath(new URL('../preset/', import.meta.url))
    let inserted
    if (!presets.resolvedRoots.some((entry) => entry.path === root)) {
      inserted = { path: root, trust: 'system' }
      presets.resolvedRoots.unshift(inserted)
    }
    const restore = patchAgentPresets(presets, { filterPreset, defaultPreset: DEFAULT_PRESET })
    return () => { restore(); if (inserted) { const index = presets.resolvedRoots.indexOf(inserted); if (index >= 0) presets.resolvedRoots.splice(index, 1); } }
  }

  // dsh 0.1.7: register the declarative preset definitions directly.
  if (typeof presets.register !== 'function') return
  if (presets.__sakerDeclarativeRegistered) return
  presets.__sakerDeclarativeRegistered = true
  const disposers = []
  let restoreAgentPresets = () => {}
  try {
    for (const id of DECLARATIVE_PRESETS) {
      disposers.push(await presets.register(loadPresetConfig(id, ctx)))
    }
    restoreAgentPresets = patchAgentPresets(presets, { filterPreset, defaultPreset: DEFAULT_PRESET })
  } catch (error) {
    presets.__sakerDeclarativeRegistered = false
    for (const dispose of disposers.reverse()) {
      try {
        await dispose()
      } catch {
        // Best-effort rollback; the registry may already be disposing.
      }
    }
    throw error
  }
  return async () => {
    presets.__sakerDeclarativeRegistered = false
    restoreAgentPresets()
    for (const dispose of disposers.reverse()) {
      try {
        await dispose()
      } catch {
        // Best-effort cleanup during plugin teardown.
      }
    }
  }
}
