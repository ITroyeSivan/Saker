import { createHash } from 'node:crypto'

export const WORKFLOW_SCHEMA_VERSION = 3
export const WORKFLOW_LIMITS = Object.freeze({ minNodes: 2, maxNodes: 12, maxInstruction: 1200, maxRunsPerSession: 20 })
export const NODE_COMPLETIONS = Object.freeze(['artifact', 'receipt'])
export const EVIDENCE_POLICIES = Object.freeze(['fresh', 'reuse', 'none'])

const text = value => typeof value === 'string' ? value.trim() : ''
const id = value => /^[a-z][a-z0-9_-]{1,48}$/.test(text(value))
const RECEIPT_TOOLS = new Set(['redteam_execution', 'saker_browser', 'oob_probe', 'competition_execution'])
const CONTROL_FIELDS = [
  'edges', 'branches', 'conditions', 'condition', 'when', 'on', 'switch', 'loop',
  'repeat', 'foreach', 'parallel', 'join', 'goto', 'transitions', 'onSuccess', 'onFailure',
]
const DISPLAY_FIELDS = new Set(['x', 'y', 'position', 'layout', 'ui'])

const hasControlValue = value => value !== undefined && value !== null && value !== false
  && (!Array.isArray(value) || value.length > 0)
  && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0)

function controlErrors(value, scope) {
  if (!value || typeof value !== 'object') return []
  const errors = []
  for (const field of CONTROL_FIELDS) {
    if (hasControlValue(value[field]))
      errors.push(`${scope}.${field}: non-linear control fields are not supported; use ordered nodes only`)
  }
  return errors
}

export function semanticHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function normalizeDefinition(input) {
  if (!input || typeof input !== 'object') throw new Error('workflow definition must be an object')
  const definition = {
    schema: WORKFLOW_SCHEMA_VERSION,
    id: text(input.id),
    version: text(input.version || '1'),
    title: text(input.title),
    description: text(input.description),
    mode: text(input.mode || 'pentest'),
    nodes: Array.isArray(input.nodes) ? input.nodes.map((node, index) => {
      const tools = Array.isArray(node?.tools) ? [...new Set(node.tools.map(text).filter(Boolean))] : []
      const declaredCompletion = text(node?.completion)
      const completion = NODE_COMPLETIONS.includes(declaredCompletion)
        ? declaredCompletion
        : tools.some(tool => RECEIPT_TOOLS.has(tool)) ? 'receipt' : 'artifact'
      const declaredPolicy = text(node?.evidencePolicy)
      const evidencePolicy = EVIDENCE_POLICIES.includes(declaredPolicy)
        ? declaredPolicy
        : completion === 'receipt' ? 'fresh' : 'none'
      return {
        id: text(node?.id),
        order: index,
        title: text(node?.title),
        instruction: text(node?.instruction),
        tools,
        output: text(node?.output),
        completion,
        evidencePolicy,
        identityRef: text(node?.identityRef),
        next: node?.next === undefined ? undefined : node.next === null || text(node.next) === '' ? null : text(node.next),
      }
    }) : [],
  }
  definition.nodes.forEach((node, index) => {
    if (node.next === undefined) node.next = definition.nodes[index + 1]?.id ?? null
  })
  definition.contentHash = semanticHash({ ...definition, contentHash: undefined })
  return definition
}

export function validateDefinition(input) {
  const definition = normalizeDefinition(input)
  const errors = [...controlErrors(input, 'workflow')]
  if (!id(definition.id)) errors.push('id must match [a-z][a-z0-9_-]{1,48}')
  if (!definition.title) errors.push('title is required')
  if (!definition.version) errors.push('version is required')
  if (definition.nodes.length < WORKFLOW_LIMITS.minNodes) errors.push('at least two nodes are required')
  if (definition.nodes.length > WORKFLOW_LIMITS.maxNodes) errors.push('too many nodes')
  const seen = new Set()
  for (const node of definition.nodes) {
    errors.push(...controlErrors(input.nodes?.[node.order], `node ${node.id || node.order + 1}`))
    if (!id(node.id)) errors.push(`invalid node id: ${node.id}`)
    if (seen.has(node.id)) errors.push(`duplicate node id: ${node.id}`)
    seen.add(node.id)
    if (!node.title) errors.push(`node ${node.id}: title is required`)
    if (!node.instruction) errors.push(`node ${node.id}: instruction is required`)
    if (Buffer.byteLength(node.instruction, 'utf8') > WORKFLOW_LIMITS.maxInstruction)
      errors.push(`node ${node.id}: instruction is too long`)
    if (!NODE_COMPLETIONS.includes(node.completion))
      errors.push(`node ${node.id}: completion must be artifact or receipt`)
    if (!EVIDENCE_POLICIES.includes(node.evidencePolicy))
      errors.push(`node ${node.id}: evidencePolicy must be fresh, reuse or none`)
    if (node.completion === 'receipt' && node.evidencePolicy === 'none')
      errors.push(`node ${node.id}: receipt completion cannot use evidencePolicy=none`)
    if (node.evidencePolicy === 'none' && node.identityRef)
      errors.push(`node ${node.id}: identityRef requires fresh or reuse evidence`)
  }
  const first = definition.nodes[0]?.id
  for (const node of definition.nodes) {
    const expected = definition.nodes[node.order + 1]?.id ?? null
    if (node.next !== expected)
      errors.push(`node ${node.id}: only the immediate next step is supported (${expected || 'end'})`)
  }
  return { ok: errors.length === 0, definition, errors, first }
}

export function publicDefinition(definition) {
  return {
    id: definition.id,
    version: definition.version,
    title: definition.title,
    description: definition.description,
    mode: definition.mode,
    contentHash: definition.contentHash,
    nodes: definition.nodes.map(({ id, title, instruction, tools, output, completion,
      evidencePolicy, identityRef, next }) =>
      ({ id, title, instruction, tools, output, completion, evidencePolicy, identityRef, next })),
  }
}

export function isDisplayOnlyField(key) {
  return DISPLAY_FIELDS.has(String(key || ''))
}
