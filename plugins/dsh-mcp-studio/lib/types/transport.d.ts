import type { ServerEntry } from './types.ts';
/** Default per-request timeout when the caller does not supply one. */
export declare const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
export interface McpChannel {
    /** Send one request and resolve with its `result`; rejects on error, timeout, or disconnect. */
    request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
    /** Send one notification (no id, no response expected). */
    notify(method: string, params?: unknown): void;
    /** Whether the underlying transport is still usable. */
    readonly alive: boolean;
    /** Tear the connection down. Safe to call repeatedly. */
    close(): void;
    /** Why the channel ended, when it ended unexpectedly. */
    readonly closedReason?: string;
}
/** 命令是包运行器时返回它要访问的 registry 主机；普通可执行文件返回空串。 */
export declare function runnerRegistryHost(command: string): string;
/**
 * 包运行器出站判定（同步）。非包运行器返回 `{ decision: 'allow', reason: 'no-registry-fetch' }`，
 * 因为本地已装可执行文件不产生下载流量。
 */
export declare function evaluateRunnerEgress(server: ServerEntry): {
    decision: 'allow' | 'deny';
    reason: string;
    mode: string;
    host: string;
};
/** Open one channel to the configured server. Throws only on configuration problems, not on wire failures. */
export declare function openChannel(server: ServerEntry): McpChannel;
export interface HandshakeResult {
    readonly protocolVersion?: string;
    readonly serverName?: string;
    readonly serverVersion?: string;
}
/** Run the MCP opening handshake on an already-open channel. */
export declare function handshake(channel: McpChannel, clientName?: string, timeoutMs?: number): Promise<HandshakeResult>;
/** One raw tool descriptor as the server advertises it. */
export interface RawToolDescriptor {
    readonly name: string;
    readonly description: string;
    /** JSON Schema for the arguments, kept verbatim so a proxy call can pass it back on demand. */
    readonly inputSchema: unknown;
}
/** Read the server's tool catalog over an already-handshaken channel. */
export declare function listTools(channel: McpChannel, timeoutMs?: number): Promise<RawToolDescriptor[]>;
