const KEY = Symbol.for('saker.tool-availability')

function state() {
  if (!globalThis[KEY]) globalThis[KEY] = { names: new Set() }
  return globalThis[KEY]
}

export function markToolAvailable(name) {
  const value = String(name || '')
  if (value) state().names.add(value)
}

export function markToolUnavailable(name) {
  const value = String(name || '')
  if (value) state().names.delete(value)
}

export function availableToolNames() {
  return new Set(state().names)
}

export function resetToolAvailability() {
  state().names.clear()
}
