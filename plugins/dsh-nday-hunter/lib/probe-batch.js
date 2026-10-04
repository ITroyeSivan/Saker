// Reuse transport only within one screening batch. Each consumer still evaluates
// its own predicate and asset control. No cross-run or cross-identity cache.
export function groupProbeRequests(requests) {
  const groups = new Map()
  for (const item of requests) {
    const plan = item.plan
    const key = JSON.stringify([plan.method, plan.url, item.hostHeader || '',
      plan.timeoutMs, item.authContext || '', plan.headers || null, plan.body ?? null])
    const existing = groups.get(key)
    if (existing) existing.consumers.push(item)
    else groups.set(key, { ...item, consumers: [item] })
  }
  return [...groups.values()]
}

export async function executeProbeBatch(groups, { mapLimit, concurrency, rateGate, fetchProbe }) {
  const responses = await mapLimit(groups, concurrency, async item => {
    await rateGate()
    const response = await fetchProbe({ ...item.plan, hostHeader: item.hostHeader })
    return item.consumers.map(consumer => ({ ...consumer, response }))
  })
  return responses.flat()
}
