/** Shared section shape, schema, and pure helpers. */
import z from '@deepseek-ai/schemastery';
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client';
/** Stable row id grammar. */
export declare const ID_PATTERN: RegExp;
/** Default per-tool-call timeout passed to the mcp-client bridge (ms). */
export declare const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000;
/** `auto` switches to proxy at or above this many tools per server. */
export declare const DEFAULT_PROXY_THRESHOLD = 10;
export type Transport = 'stdio' | 'streamable-http';
/**
 * How a server's tools reach the model.
 * - `auto`   — proxy when the server carries at least `proxyThreshold` tools, direct below that.
 * - `direct` — one model-facing tool per server tool (`mcp__<server>__<tool>`).
 * - `proxy`  — only `mcp_search` / `mcp_call`; metadata is fetched on demand.
 * - `hybrid` — `proxy`, plus `directTools` promoted back to real `mcp__<server>__<tool>` entries.
 */
export type Exposure = 'auto' | 'direct' | 'proxy' | 'hybrid';
/** One user-configured MCP server row. */
export interface ServerEntry {
    /** Stable row identity used to diff mounted instances. */
    readonly id: string;
    /** Disabled rows are kept in the document but mount nothing. */
    readonly enabled: boolean;
    /** Model-facing tool namespace: `mcp__<name>__<tool>`; unique across enabled rows. */
    readonly name: string;
    readonly transport: Transport;
    /** stdio: executable to spawn. */
    readonly command: string;
    /** stdio: one-line argument string (split on whitespace, quotes honored). */
    readonly argsLine: string;
    /** stdio: extra environment variables merged over the scrubbed parent env. */
    readonly env: Record<string, string>;
    /** stdio: working directory for the child process. */
    readonly cwd: string;
    /** streamable-http: MCP endpoint URL. */
    readonly url: string;
    /** streamable-http: extra request headers (e.g. Authorization). */
    readonly headers: Record<string, string>;
    /** Per-tool-call timeout in milliseconds. */
    readonly toolCallTimeoutMs: number;
    /** Reject the mount when the initial connection or tool sync fails. */
    readonly failOnStartupError: boolean;
    /** Which tools reach the model; see {@link Exposure}. */
    readonly exposure: Exposure;
    /** `auto` threshold: at or above this many tools the server is proxied. */
    readonly proxyThreshold: number;
    /** `hybrid` only: raw tool names kept as real `mcp__<name>__<tool>` entries. */
    readonly directTools: string[];
}
/** The whole `mcp-studio` settings section. */
export interface StudioSection {
    readonly servers: ServerEntry[];
}
export declare const ServerEntrySchema: z<ServerEntry>;
export declare const Config: z<StudioSection>;
/** Split one argument line into argv tokens; single/double quotes and backslash escapes are honored. */
export declare function splitArgs(line: string): string[];
/** Project one server row onto the mcp-client config shape. */
export declare function toMcpClientConfig(server: ServerEntry): McpClientConfig;
/** Cross-field constraints the schema cannot express; throwing refuses the write. */
export declare function validateSection(value: StudioSection): void;
