/**
 * Ambient declaration for the host-provided `@deepseek-ai/dsh-tools`.
 *
 * Why not a real dependency: dsh injects this package into plugin bundles at load time
 * (`build.mjs` keeps every `@deepseek-ai/*` external), and it is not on the public
 * registry, so `tsc` has nothing to resolve against. Declaring the slice this plugin
 * actually uses keeps the type-check honest without inventing a runtime dependency —
 * and `defineTool` is identity-shaped at runtime, so the declaration adds no behaviour.
 *
 * @module dsh-mcp-studio/host-modules
 */
declare module '@deepseek-ai/dsh-tools' {
  /** One model-facing tool. Only the fields this plugin sets are declared. */
  interface ToolDefinition {
    name: string
    description: string
    parameters?: Record<string, unknown>
    output?: {
      schema: Record<string, unknown>
      render?: (args: Record<string, any>, value: Record<string, any>) => unknown
    }
    execute?: (args: Record<string, any>, exec?: unknown) => unknown
  }

  /** Declare a tool; the host validates the definition and returns it. */
  export function defineTool<T extends ToolDefinition>(definition: T): T
}
