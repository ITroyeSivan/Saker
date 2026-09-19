import type { ServerEntry, StudioSection } from './types.ts';
/** Model-facing names of the two meta-tools. */
export declare const META_TOOL_SEARCH = "mcp_search";
export declare const META_TOOL_CALL = "mcp_call";
/** Re-list a catalog once it is older than this, so `tools/list_changed` needs no handler. */
export declare const CATALOG_TTL_MS: number;
/** Default `mcp_search` result count. */
export declare const SEARCH_DEFAULT_LIMIT = 8;
/** Hard cap on `mcp_search` results — dumping the catalog is the cost this mode exists to avoid. */
export declare const SEARCH_MAX_LIMIT = 30;
/** One tool as this module remembers it. */
export interface ToolMeta {
    /** Configured server name (the `mcp__<server>__` namespace, unwrapped). */
    readonly server: string;
    /** Raw tool name as the server advertises it. */
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
}
export type ExposureDecision = 'direct' | 'proxy' | 'pending';
/** Add a known integration hint without mutating the upstream descriptor. */
export declare function applyToolHint(server: string, name: string, description: string): string;
/**
 * Effective exposure for one server.
 * @param server - configured row; `exposure` and `proxyThreshold` are read.
 * @param toolCount - tools the server advertises, or `undefined` before the first list.
 * @returns `direct`, `proxy`, or `pending` — `auto` with an unknown count must keep the
 *   connection alive long enough to learn the count, so it cannot answer yet.
 */
export declare function decideExposure(server: Pick<ServerEntry, 'exposure' | 'proxyThreshold'>, toolCount: number | undefined): ExposureDecision;
/** Split a query into lowercase tokens on whitespace and common separators. */
export declare function tokenize(query: unknown): string[];
/** Score one tool against query tokens: name hits dominate, an exact name short-circuits. */
export declare function scoreTool(meta: ToolMeta, tokens: readonly string[]): number;
/** Rank a catalog against a query. Zero-score tools are dropped, so an unmatched query returns nothing. */
export declare function rankTools(metas: readonly ToolMeta[], options?: {
    query?: unknown;
    server?: unknown;
    limit?: unknown;
}): ToolMeta[];
/** Compact argument hint: declared property names, `?` on optional ones, `…` when the schema is open. */
export declare function paramHint(inputSchema: unknown): string;
/** One catalog line: what the model uses to decide whether a hit is worth calling. */
export declare function toolLine(meta: ToolMeta): string;
/** Render a search result as the model-facing text block. */
export declare function renderSearchText(matches: readonly ToolMeta[], context: {
    query?: unknown;
    total: number;
}): string;
/** Per-server catalog sizes, for status/debug output. */
export declare function summarizeCatalog(metas: readonly ToolMeta[]): Array<{
    server: string;
    tools: number;
}>;
/**
 * Convert one JSON Schema property into a `defineTool` parameter declaration.
 *
 * Unsupported shapes (unions, const/enum-only, nested) become `json`, which accepts any
 * JSON value. Widening is safe; guessing is not — the registry validates arguments against
 * what we declare, so declaring `string` for a union would reject the very call the model
 * was told to make.
 */
export declare function toParameterDeclaration(property: unknown): Record<string, unknown>;
/** Build `defineTool` parameters for one raw tool descriptor. */
export declare function toToolParameters(inputSchema: unknown): Record<string, unknown>;
interface MountNote {
    state: 'connecting' | 'ready' | 'error';
    error?: string;
    tools: ToolMeta[];
    listedAt: number;
    nextRetryAt: number;
}
export interface CallResult {
    ok: boolean;
    text: string;
    structured?: unknown;
    error?: string;
}
/** Connects to proxied servers, caches their catalogs, and answers `mcp_search` / `mcp_call`. */
export declare class ProxyRegistry {
    private readonly mounts;
    /**
     * Last successfully listed tool count per server name, keyed by the row's connection
     * fingerprint. Sticky on purpose. `auto` decides from this number, and the moment it
     * decides "small, mount directly" the server leaves the proxy set — so a count read off
     * the live mount alone forgets itself the instant it is used. That produced a live-only
     * oscillation: pending → proxy (list 3) → direct → pending (count gone) → proxy → … with
     * the direct mount torn down on every lap and the server's tools never staying visible.
     * A learning that survives the mount is what makes the decision a one-way door; editing
     * the row (its fingerprint changes) or calling dropServer() is what opens it again.
     */
    private readonly learned;
    private readonly section;
    private readonly log;
    constructor(section: () => StudioSection, log?: (format: string, ...args: unknown[]) => void);
    /**
     * What makes two versions of a row "the same server" for the purposes of a learned count.
     * Deliberately excludes exposure/proxyThreshold/directTools: toggling a row between `auto`
     * and `proxy` must not throw away what we already learned about its catalog size.
     */
    private fingerprintOf;
    /** All catalogs, concatenated. */
    catalog(): ToolMeta[];
    /** One server's catalog (`[]` when unlisted). */
    catalogFor(serverName: string): ToolMeta[];
    /**
     * A server's catalog size, or `undefined` while it has never answered.
     * The distinction matters: `auto` must not treat "connect not attempted" as "zero tools"
     * and permanently fall back to a direct mount without ever looking.
     *
     * A live reading wins, but a learned one is used when the server is no longer mounted by
     * the proxy — which is the normal state of every `auto` row that resolved to `direct`.
     */
    listedCount(serverName: string): number | undefined;
    /** Per-server catalog state, for the status page. */
    stateOf(serverName: string): {
        state: 'connecting' | 'ready' | 'error';
        error?: string;
    } | undefined;
    /** Whether a server has a usable catalog — the proxied equivalent of "its tools are visible". */
    hasCatalog(serverName: string): boolean;
    /** Per-server state for the status page and `debug`. */
    snapshot(): Array<{
        id: string;
        name: string;
        state: MountNote['state'];
        tools: number;
        error?: string;
    }>;
    private mountByName;
    private serverOf;
    private closeMount;
    /** Close everything (plugin unload). */
    closeAll(): void;
    /**
     * Reconcile mounts against `list` (the rows whose exposure may be proxied).
     * A row that leaves `list` or changes its name is torn down; a new row gets a channel.
     *
     * Only rows present in `list` are examined for staleness — a row that left because `auto`
     * resolved it to `direct` must keep its learned count, or the decision it just made would
     * be erased on the next reconcile.
     */
    syncServers(list: readonly ServerEntry[]): void;
    /** Forget one mount by server name (used when `auto` resolves to a direct mount instead). */
    dropServer(serverName: string): void;
    /**
     * Make sure a server's catalog is loaded and fresh. Never throws: failures land in the
     * server's note so `mcp_search` can report them instead of the caller seeing a crash.
     */
    ensure(serverName: string, options?: {
        force?: boolean;
    }): Promise<MountNote | undefined>;
    /** Load every proxied server's catalog (mount-time warm-up). */
    ensureAll(): Promise<void>;
    /** Search across all catalogs, refreshing missing or stale ones first. */
    search(options?: {
        query?: unknown;
        server?: unknown;
        limit?: unknown;
    }): Promise<{
        matches: ToolMeta[];
        total: number;
        errors: Array<{
            name: string;
            error: string;
        }>;
    }>;
    /** Forward one `tools/call`. */
    call(serverName: string, tool: string, args: unknown): Promise<CallResult>;
    /**
     * Register `mcp_search` + `mcp_call` against the host tool registry.
     * @returns one disposer per registration, so a reconcile that leaves no proxied server
     *   can withdraw the pair rather than leaving two dead tools in the prompt.
     */
    registerMetaTools(ctx: {
        tools: {
            register(definition: unknown): unknown;
        };
    }): Array<() => void>;
    /**
     * Register the `directTools` of a hybrid server as real `mcp__<server>__<tool>` entries.
     * @returns the registered names, the names with no metadata (server does not advertise
     *   them), and a disposer per registration so a reconfigure can undo it.
     */
    registerPromotedTools(ctx: {
        tools: {
            register(definition: unknown): unknown;
        };
    }, server: Pick<ServerEntry, 'name' | 'directTools'>): {
        registered: string[];
        missing: string[];
        disposers: Array<() => void>;
    };
}
export {};
