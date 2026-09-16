/** Connection diagnostics: one short-lived MCP handshake (stdio or streamable-http) reporting elapsed time, protocol version, server info, and tool count. */
import { handshake, listTools, openChannel, DEFAULT_REQUEST_TIMEOUT_MS } from './transport.ts'
import type { ServerEntry } from './types.ts'

export interface DiagnoseReport {
  readonly ok: boolean
  readonly elapsedMs: number
  readonly protocolVersion?: string
  readonly serverName?: string
  readonly serverVersion?: string
  readonly toolCount?: number
  readonly error?: string
}

/** Run one full handshake: a throwaway channel, opened and closed around initialize + tools/list. */
export async function diagnoseServer(server: ServerEntry): Promise<DiagnoseReport> {
  const started = Date.now()
  const channel = openChannel(server)
  try {
    const info = await handshake(channel, 'dsh-mcp-studio-diag', DEFAULT_REQUEST_TIMEOUT_MS)
    const tools = await listTools(channel, DEFAULT_REQUEST_TIMEOUT_MS)
    return {
      ok: true,
      elapsedMs: Date.now() - started,
      ...info,
      toolCount: tools.length,
    }
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    channel.close()
  }
}
