import type { ServerEntry } from './types.ts';
export interface DiagnoseReport {
    readonly ok: boolean;
    readonly elapsedMs: number;
    readonly protocolVersion?: string;
    readonly serverName?: string;
    readonly serverVersion?: string;
    readonly toolCount?: number;
    readonly error?: string;
}
/** Run one full handshake: a throwaway channel, opened and closed around initialize + tools/list. */
export declare function diagnoseServer(server: ServerEntry): Promise<DiagnoseReport>;
