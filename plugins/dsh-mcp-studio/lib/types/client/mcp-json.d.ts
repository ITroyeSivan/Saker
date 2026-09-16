/** MCP config JSON parser and exporter: accepts {"mcpServers":…} / {"servers":…} / bare maps / single-server objects / one wrapper level; non-server metadata keys are ignored. */
import type { ServerDraft } from './contracts.js';
/** Machine-readable paste/import diagnostic; the UI owns the wording (see locales.ts). */
export type McpJsonErrorCode = 'empty' | 'badJson' | 'notObject' | 'noServers' | 'skipped';
export interface McpJsonError {
    readonly code: McpJsonErrorCode;
    /** badJson: 1-based line of the syntax error, when the engine reports one. */
    readonly line?: number;
    /** badJson: 1-based column of the syntax error, when the engine reports one. */
    readonly column?: number;
    /** badJson: 0-based character offset, when the engine reports one. */
    readonly position?: number;
    /** skipped: the entry name that could not be read as a server. */
    readonly name?: string;
    /** badJson: the character the engine choked on, when it names one. */
    readonly token?: string;
}
/**
 * Pull line/column/position/token out of a JSON.parse SyntaxError message. The engine's
 * own wording stays inside this function — no parser prose may reach the UI (see locales.ts).
 * Node 22/24 emit two shapes, and the second one carries no location at all:
 *   Expected ':' after property name in JSON at position 28 (line 3 column 9)
 *   Unexpected token '}', "{"a": }" is not valid JSON
 */
export declare function jsonErrorDetail(error: unknown): Pick<McpJsonError, 'line' | 'column' | 'position' | 'token'>;
export interface McpJsonParseResult {
    readonly servers: ServerDraft[];
    readonly warnings: McpJsonError[];
}
/** args array → one argsLine the user can keep editing (quotes preserved). */
export declare function argsToLine(args: readonly unknown[]): string;
/** Built-in starter template pre-filled into the paste drawer. */
export declare const MCP_JSON_TEMPLATE = "{\n  \"mcpServers\": {\n    \"example\": {\n      \"command\": \"npx\",\n      \"args\": [\"-y\", \"@modelcontextprotocol/server-everything\"],\n      \"env\": {}\n    }\n  }\n}";
/**
 * Pretty-print any pasted config (two-space indent); returns an error for invalid JSON.
 */
export declare function formatMcpJson(text: string): {
    text: string;
} | {
    error: McpJsonError;
};
/** argsLine → argv array (whitespace split, quotes honored). */
export declare function lineToArgs(line: string): string[];
/** Project drafts back onto the Claude Desktop `mcpServers` JSON shape (export path). */
export declare function serversToMcpJson(servers: ReadonlyArray<{
    name: string;
    transport: 'stdio' | 'streamable-http';
    command: string;
    argsLine: string;
    env: ReadonlyArray<{
        key: string;
        value: string;
    }>;
    cwd: string;
    url: string;
    headers: ReadonlyArray<{
        key: string;
        value: string;
    }>;
}>): string;
/** Parse a pasted JSON document into server drafts; names deduplicate with suffixes. */
export declare function parseMcpJson(text: string, existing?: Readonly<Iterable<string>>): McpJsonParseResult | {
    error: McpJsonError;
};
