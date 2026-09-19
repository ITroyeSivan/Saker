#!/usr/bin/env node
// Idempotently add reasoning metadata to a hand-declared llm-pi-ai model.
//
// The host cannot infer effort levels for custom OpenAI-compatible routes that
// are absent from its installed model catalog. This script edits only the
// target model object in settings.yaml, validates the full YAML before writing,
// and keeps a timestamped backup.
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APPLY = process.argv.includes('--apply')

function values(name) {
  const out = []
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === name && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) out.push(process.argv[i + 1])
  }
  return out
}

function value(name, fallback) {
  return values(name)[0] ?? fallback
}

const provider = value('--provider', 'custom')
const modelId = value('--model', 'deepseek-flash')
const format = value('--format', 'deepseek')
const effortNames = value('--efforts', 'off,low,high,max').split(',').map((x) => x.trim()).filter(Boolean)
const settingsFiles = values('--settings')
if (!settingsFiles.length) settingsFiles.push(join(homedir(), '.dsh', 'settings.yaml'))

function loadYaml() {
  let localHostSources = []
  try {
    const refRoot = join(ROOT, '..', '_ref')
    localHostSources = readdirSync(refRoot)
      .filter((name) => name.startsWith('dsh-src-'))
      .map((name) => join(refRoot, name))
  } catch { /* _ref is optional */ }
  const candidates = [
    process.env.DSH_SRC,
    ...localHostSources,
    join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'js-yaml'),
    join(ROOT, 'node_modules', 'js-yaml'),
    join(process.cwd(), 'node_modules', 'js-yaml'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    const pkg = join(candidate, 'package.json')
    if (!existsSync(pkg)) continue
    try {
      return createRequire(pathToFileURL(pkg).href)('js-yaml')
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('找不到 js-yaml；设置 DSH_SRC 指向 dsh 源码树，或在 profile 中先安装依赖')
}

const yaml = loadYaml()

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchingClose(text, open, openChar, closeChar) {
  let depth = 0
  let quote = ''
  let escaped = false
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === openChar) depth += 1
    else if (ch === closeChar) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function appendField(objectText, fieldText) {
  const open = objectText.indexOf('{')
  const close = matchingClose(objectText, open, '{', '}')
  if (open < 0 || close < 0) throw new Error('模型对象不是完整 flow map')
  const before = objectText.slice(0, close).trimEnd()
  const comma = before.endsWith(',') ? '' : ','
  return objectText.slice(0, close) + comma + ' ' + fieldText + objectText.slice(close)
}

function compatDefault() {
  if (format === 'deepseek') {
    return '{ supportsStore: false, supportsDeveloperRole: false, maxTokensField: max_tokens, requiresReasoningContentOnAssistantMessages: true, thinkingFormat: deepseek }'
  }
  return `{ thinkingFormat: ${format} }`
}

function patchModel(objectText) {
  let out = objectText
  let changed = false
  const compatAt = /\bcompat\s*:\s*\{/.exec(out)
  if (compatAt) {
    const open = compatAt.index + compatAt[0].lastIndexOf('{')
    const close = matchingClose(out, open, '{', '}')
    if (close < 0) throw new Error('compat 不是完整 flow map')
    const compat = out.slice(open, close + 1)
    const current = /\bthinkingFormat\s*:\s*([^,}]+)/.exec(compat)
    if (current && current[1].trim() !== format) {
      throw new Error(`thinkingFormat 已是 ${current[1].trim()}，拒绝覆盖为 ${format}`)
    }
    if (!current) {
      const before = compat.slice(0, -1).trimEnd()
      const comma = before.endsWith(',') ? '' : ','
      const next = before + comma + ` thinkingFormat: ${format} }`
      out = out.slice(0, open) + next + out.slice(close + 1)
      changed = true
    }
  } else {
    out = appendField(out, `compat: ${compatDefault()}`)
    changed = true
  }

  if (!/\breasoningEfforts\s*:/.test(out)) {
    const efforts = effortNames.map((name) => `${name === 'off' ? "'off'" : name}: ${name === 'off' ? 'null' : name}`).join(', ')
    out = appendField(out, `reasoningEfforts: { ${efforts} }`)
    changed = true
  }
  return { text: out, changed }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (typeof value !== 'object' || value === null) return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key])
  return out
}

function normalized(value) {
  const copy = structuredClone(value)
  const models = copy?.['llm-pi-ai']?.providers?.[provider]?.models
  if (Array.isArray(models)) {
    for (const model of models) {
      if (model?.id !== modelId) continue
      delete model.reasoningEfforts
      if (model.compat && typeof model.compat === 'object') {
        for (const key of [
          'thinkingFormat',
          'supportsStore',
          'supportsDeveloperRole',
          'maxTokensField',
          'requiresReasoningContentOnAssistantMessages',
        ]) delete model.compat[key]
        if (Object.keys(model.compat).length === 0) delete model.compat
      }
    }
  }
  return stable(copy)
}

function findTarget(text) {
  const section = new RegExp(`^llm-pi-ai:\\s*$`, 'm').exec(text)
  if (!section) throw new Error('settings.yaml 缺少 llm-pi-ai 顶层配置')
  const providerAt = new RegExp(`^\\s*${escapeRe(provider)}:\\s*(?:\\{\\s*)?$`, 'm').exec(text.slice(section.index))
  if (!providerAt) throw new Error(`llm-pi-ai 中找不到 provider ${provider}`)
  const start = section.index + providerAt.index
  const modelsAt = /\bmodels\s*:/.exec(text.slice(start))
  if (!modelsAt) throw new Error(`provider ${provider} 没有 models 数组`)
  const idAt = new RegExp(`\\bid\\s*:\\s*${escapeRe(modelId)}\\b`).exec(text.slice(start + modelsAt.index))
  if (!idAt) throw new Error(`provider ${provider} 中找不到模型 ${modelId}`)
  const absoluteId = start + modelsAt.index + idAt.index
  const open = text.lastIndexOf('{', absoluteId)
  const close = matchingClose(text, open, '{', '}')
  if (open < 0 || close < 0) throw new Error(`模型 ${modelId} 不是完整 flow map`)
  return { open, close }
}

let changedFiles = 0
for (const file of settingsFiles) {
  if (!existsSync(file)) {
    console.log(`SKIP ${file}（文件不存在）`)
    continue
  }
  const original = readFileSync(file, 'utf8')
  const before = yaml.load(original)
  const target = findTarget(original)
  const patched = patchModel(original.slice(target.open, target.close + 1))
  if (!patched.changed) {
    console.log(`SKIP ${file}（已配置）`)
    continue
  }
  const next = original.slice(0, target.open) + patched.text + original.slice(target.close + 1)
  const after = yaml.load(next)
  if (JSON.stringify(normalized(before)) !== JSON.stringify(normalized(after))) {
    throw new Error(`拒绝修改 ${file}：目标模型以外的配置发生了变化`)
  }
  const model = after?.['llm-pi-ai']?.providers?.[provider]?.models?.find((item) => item.id === modelId)
  if (model?.compat?.thinkingFormat !== format || !model?.reasoningEfforts) {
    throw new Error(`拒绝修改 ${file}：写入后的模型元数据校验失败`)
  }
  changedFiles += 1
  if (!APPLY) {
    console.log(`DRY ${file}`)
    continue
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backup = `${file}.bak-reasoning-${stamp}`
  const tmp = join(dirname(file), `.settings-reasoning-${process.pid}.tmp`)
  copyFileSync(file, backup)
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, file)
  console.log(`OK  ${file}  backup=${backup}`)
}

if (!changedFiles && !APPLY) console.log('没有需要修改的模型')
