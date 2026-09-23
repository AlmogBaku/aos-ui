/**
 * How a tool call that declares an MCP App view reaches the message surface:
 * the runtime marks the Assistant UI part's `artifact`, which carries no view
 * data of its own. The view is fetched per tool call when it renders.
 */
export const MCP_APP_TOOL_ARTIFACT = { aos: "mcp-app" } as const

/**
 * The flag as a call progresses: `input` once its arguments are complete,
 * `settled` once the provider reports it done, and `cancelled`, with its
 * reason, once the call can no longer produce a result. A guest's call carries
 * neither its arguments nor its result, so `settled` is what tells it both are
 * ready.
 */
export function mcpAppToolArtifact({
  input,
  settled,
  cancelled,
}: {
  input: boolean
  settled: boolean
  cancelled?: string
}) {
  return {
    ...MCP_APP_TOOL_ARTIFACT,
    ...(input ? { input: true as const } : {}),
    ...(settled ? { settled: true as const } : {}),
    ...(cancelled === undefined ? {} : { cancelled }),
  }
}

type AppToolPart = {
  readonly artifact?: unknown
  readonly result?: unknown
  readonly args?: Readonly<Record<string, unknown>>
}

function flag(part: AppToolPart, key: "input" | "settled") {
  return (part.artifact as Record<string, unknown> | undefined)?.[key] === true
}

export function isMcpAppToolPart(part: { readonly artifact?: unknown }) {
  const { artifact } = part
  return (
    typeof artifact === "object" &&
    artifact !== null &&
    (artifact as { aos?: unknown }).aos === MCP_APP_TOOL_ARTIFACT.aos
  )
}

/** The call has finished, whether or not its result reached this client. */
export function isSettledMcpAppToolPart(part: AppToolPart) {
  return (
    part.result !== undefined ||
    (isMcpAppToolPart(part) && flag(part, "settled"))
  )
}

/** The call's complete arguments, once this client holds them. */
export function mcpAppToolInput(part: AppToolPart) {
  return part.result !== undefined || flag(part, "input")
    ? part.args
    : undefined
}

/**
 * Why the call ended without a result the view could show, or `undefined`
 * while it may still produce one.
 */
export function mcpAppToolCancellation(part: AppToolPart): string | undefined {
  if (part.result !== undefined || !isMcpAppToolPart(part)) return undefined
  const reason = (part.artifact as Record<string, unknown>).cancelled
  return typeof reason === "string" ? reason : undefined
}
