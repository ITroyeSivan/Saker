const aliases = {
  httpx_probe: ['httpx_probe'],
  saker_browser: ['saker_browser'],
  saker_material: ['saker_material'],
  redteam_execution: ['redteam_execution'],
  redteam_research: ['redteam_research'],
  project_evidence: ['project_evidence', 'redteam_finding_register'],
  redteam_finding_register: ['redteam_finding_register'],
  oob_probe: ['oob_probe', 'redteam_execution'],
  tool_pack: ['tool_pack'],
  semgrep_scan: ['semgrep_scan'],
  pwsh: ['pwsh'],
}

const shellAdapters = {
  semgrep_scan: { shell: 'pwsh', executable: 'semgrep', contract: 'semgrep --json with stable path/line/rule output mapping' },
}

export function resolveCapabilities(requested, liveTools = [], { verifiedAdapters = {} } = {}) {
  const live = new Set(liveTools)
  return requested.map(capability => {
    const candidates = aliases[capability] || [capability]
    const available = candidates.filter(name => live.has(name))
    if (available.length) return {
      capability,
      candidates,
      available,
      status: 'available',
      source: 'registered-tool',
      note: '',
    }
    const shell = shellAdapters[capability]
    if (shell && live.has(shell.shell)) {
      const verified = verifiedAdapters[capability]
      if (verified?.available === true && verified.contract === shell.contract) return {
        capability,
        candidates,
        available: [shell.shell],
        status: 'available',
        source: 'verified-shell-adapter',
        version: String(verified.version || ''),
        note: `已通过 ${shell.shell} 适配器验证 ${shell.executable}${verified.version ? ' ' + verified.version : ''}。`,
      }
      return {
        capability,
        candidates,
        available: [],
        status: 'adapter-unverified',
        source: 'shell-detected',
        note: `只看到 ${shell.shell}，尚未验证 ${shell.executable} 二进制、版本和 ${shell.contract}；不能视为扫描已就绪。`,
      }
    }
    return {
      capability,
      candidates,
      available: [],
      status: 'missing',
      source: '',
      note: '当前 Host 工具面没有该名称；先加载工具包或明确记录缺口。',
    }
  })
}

export function capabilityPrompt(resolved) {
  return resolved.map(item => `${item.capability}: ${item.status === 'available'
    ? item.available.join('/')
    : item.status === 'adapter-unverified' ? '仅见 Shell，适配器未验证' : '不可见'}`).join('；')
}
